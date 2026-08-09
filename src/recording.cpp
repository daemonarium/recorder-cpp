#include "recording.hpp"
#include "shield_client.hpp"
#include "sockets.hpp"

#include <socket/socket.h>
#include <utils/socket_handlers.hpp>
#include <serialization/rpc.hpp>
#include <serialization/serialize.hpp>
#include <serialization/stream_writer.hpp>
#include <io/circular_buffer.h>
#include <cstring>
#include <algorithm>
#include <set>
#include <sstream>

#ifdef __EMSCRIPTEN__
extern "C" {
  __attribute__((import_module("waos"), import_name("waos_socket_flush")))
  void waos_socket_flush(std::uint32_t socket);
}
#else
extern "C" {
  void waos_socket_flush(std::uint32_t socket);
}
#endif

namespace waos {

  std::uint64_t g_own_process_id = 3;

  namespace {

    constexpr size_t IO_CHUNK_SIZE = 48 * 1024;

    std::unordered_map<std::uint64_t, std::shared_ptr<recording>> recordings_by_id;
    std::unordered_map<std::uint32_t, std::shared_ptr<recording>> recordings_by_monitor;
    std::unordered_map<std::uint32_t, std::shared_ptr<recording>> recordings_by_log;
    std::uint64_t next_recording_id = 1;
    std::uint32_t next_dynamic_socket = static_cast<std::uint32_t>(base_socket_id::FIRST_DYNAMIC);

    struct socket_options large_socket_options() {
      return socket_options{
        // Large enough for a full ModuleProcess memory snapshot and chunked code.wasm
        // (mock-module e2e uses ~1MiB linear memory and ~6MiB WASM).
        .input_buffer_size = 8 * 1024 * 1024,
        .output_buffer_size = 8 * 1024 * 1024,
        .flush_threshold = 4096,
        .data_event_threshold = 0,
        .drain_event_threshold = 4,
        .flags = 0,
      };
    }

    template <typename T>
    std::vector<std::uint8_t> serialize_to_bytes(const T& value) {
      std::ostringstream oss;
      serialization::stream_writer writer(oss);
      serialize(writer, value);
      writer.write_rest();
      std::string s = oss.str();
      return std::vector<std::uint8_t>(s.begin(), s.end());
    }

  }

  std::shared_ptr<recording> get_recording(std::uint64_t recording_id) {
    auto it = recordings_by_id.find(recording_id);
    if(it == recordings_by_id.end()) return nullptr;
    return it->second;
  }

  std::shared_ptr<recording> get_recording_by_monitor_socket(std::uint32_t socket_id) {
    auto it = recordings_by_monitor.find(socket_id);
    if(it == recordings_by_monitor.end()) return nullptr;
    return it->second;
  }

  std::shared_ptr<recording> get_recording_by_log_socket(std::uint32_t socket_id) {
    auto it = recordings_by_log.find(socket_id);
    if(it == recordings_by_log.end()) return nullptr;
    return it->second;
  }

  std::shared_ptr<recording> create_recording(start_recording_request request) {
    auto id = next_recording_id++;
    auto rec = std::make_shared<recording>(id, std::move(request));
    recordings_by_id[id] = rec;
    return rec;
  }

  void erase_recording(std::uint64_t recording_id) {
    auto rec = get_recording(recording_id);
    if(!rec) return;
    recordings_by_monitor.erase(rec->monitor_socket());
    recordings_by_log.erase(rec->log_socket());
    recordings_by_id.erase(recording_id);
  }

  recording::recording(std::uint64_t recording_id, start_recording_request request)
    : recording_id_(recording_id)
    , request_(std::move(request))
  {}

  recording::~recording() = default;

  monitor_config recording::build_monitor_config() const {
    std::uint32_t flags =
      static_cast<std::uint32_t>(monitor_flag::COPY)
      | static_cast<std::uint32_t>(monitor_flag::COPY_PAYLOAD)
      | static_cast<std::uint32_t>(monitor_flag::DATA)
      | static_cast<std::uint32_t>(monitor_flag::DRAIN)
      | static_cast<std::uint32_t>(monitor_flag::SAVE)
      | static_cast<std::uint32_t>(monitor_flag::ERROR)
      | static_cast<std::uint32_t>(monitor_flag::BIND);
    if(request_.config.record_mana) {
      flags |= static_cast<std::uint32_t>(monitor_flag::MANA);
    }
    return monitor_config{ .flags = flags };
  }

  std::uint32_t recording::alloc_socket() {
    return next_dynamic_socket++;
  }

  void recording::open_socket(std::uint32_t id) {
    auto opts = large_socket_options();
    socket_open(id, &opts);
  }

  void recording::close_socket(std::uint32_t id) {
    if(id == 0) return;
    socket_handlers::unregister_socket_handler(id);
    socket_close(id);
  }

  std::vector<std::uint8_t> recording::capture_current_frame(size_t msg_len) {
    auto* sock = get_socket_info(monitor_socket_);
    std::vector<std::uint8_t> frame(sizeof(std::uint32_t) + msg_len);
    std::uint32_t len32 = static_cast<std::uint32_t>(msg_len);
    std::memcpy(frame.data(), &len32, sizeof(len32));
    circular_buffer_peek(&sock->input_buffer, 0, frame.data() + sizeof(len32), msg_len);
    return frame;
  }

  void recording::append_io_frame(std::vector<std::uint8_t> frame) {
    io_bytes_.insert(io_bytes_.end(), frame.begin(), frame.end());
  }

  void recording::setup_monitor_channel() {
    monitor_channel_ = std::make_unique<serialization::socket_message_channel>(monitor_socket_);
    // Wire indices must match kernel ProcessMonitorEmitter (rpc_* then process_*).
    monitor_channel_->register_message_type<serialization::rpc_request>();
    monitor_channel_->register_message_type<serialization::rpc_response>();
    monitor_channel_->register_message_type<serialization::rpc_error>();
    monitor_channel_->register_message_type<process_killed_event>();
    monitor_channel_->register_message_type<process_error_event>();
    monitor_channel_->register_message_type<process_copy_event>();
    monitor_channel_->register_message_type<process_data_event>();
    monitor_channel_->register_message_type<process_drain_event>();
    monitor_channel_->register_message_type<process_save_event>();
    monitor_channel_->register_message_type<process_memory_event>();
    monitor_channel_->register_message_type<process_socket_state_event>();
    monitor_channel_->register_message_type<process_measure_mana_event>();
    monitor_channel_->register_message_type<process_set_mana_limit_event>();
    monitor_channel_->register_message_type<process_bind_event>();
    monitor_channel_->register_message_type<process_unbind_event>();

    auto self = shared_from_this();

    monitor_channel_->on_message<process_save_event>([self](process_save_event& ev, size_t payload_size) {
      size_t msg_len = self->monitor_channel_->reader().read_offset_ + payload_size;
      auto frame = self->capture_current_frame(msg_len);
      self->on_save_event(ev.snapshot_uid, std::move(frame));
    });

    monitor_channel_->on_message<process_error_event>([self](process_error_event&, size_t) {
      self->on_error_event();
    });

    monitor_channel_->on_message<process_killed_event>([](process_killed_event&, size_t) {
      // no dump
    });

    auto on_io = [self](auto&, size_t payload_size) {
      size_t msg_len = self->monitor_channel_->reader().read_offset_ + payload_size;
      self->on_io_frame(self->capture_current_frame(msg_len));
    };
    monitor_channel_->on_message<process_copy_event>(on_io);
    monitor_channel_->on_message<process_data_event>(on_io);
    monitor_channel_->on_message<process_drain_event>(on_io);
    monitor_channel_->on_message<process_measure_mana_event>([self](process_measure_mana_event&, size_t payload_size) {
      if(!self->request_.config.record_mana) return;
      size_t msg_len = self->monitor_channel_->reader().read_offset_ + payload_size;
      self->on_io_frame(self->capture_current_frame(msg_len));
    });
    monitor_channel_->on_message<process_set_mana_limit_event>([self](process_set_mana_limit_event&, size_t payload_size) {
      if(!self->request_.config.record_mana) return;
      size_t msg_len = self->monitor_channel_->reader().read_offset_ + payload_size;
      self->on_io_frame(self->capture_current_frame(msg_len));
    });
    monitor_channel_->on_message<process_bind_event>([self](process_bind_event& ev, size_t payload_size) {
      size_t msg_len = self->monitor_channel_->reader().read_offset_ + payload_size;
      self->on_io_frame(self->capture_current_frame(msg_len));
      self->queue_registry_refresh(ev.peer_process, static_cast<std::uint32_t>(ev.peer_socket));
    });
    monitor_channel_->on_message<process_unbind_event>([self](process_unbind_event&, size_t payload_size) {
      size_t msg_len = self->monitor_channel_->reader().read_offset_ + payload_size;
      self->on_io_frame(self->capture_current_frame(msg_len));
    });

    socket_handlers::register_socket_handler(monitor_socket_, [self]() {
      self->handle_monitor_data();
    });
  }

  void recording::setup_log_channel() {
    log_channel_ = std::make_unique<serialization::socket_message_channel>(log_socket_);
    log_channel_->register_message_type<serialization::rpc_request>();
    log_channel_->register_message_type<serialization::rpc_response>();
    log_channel_->register_message_type<serialization::rpc_error>();
    log_channel_->register_message_type<debug_snapshot_event>();
    log_channel_->register_message_type<debug_io_event>();
    log_channel_->register_message_type<debug_logs_event>();
    log_channel_->register_message_type<debug_spans_event>();
    log_channel_->register_message_type<debug_metrics_event>();

    auto self = shared_from_this();
    auto forward = [self](auto&, size_t payload_size) {
      auto* sock = get_socket_info(self->log_socket_);
      size_t msg_len = self->log_channel_->reader().read_offset_ + payload_size;
      std::vector<std::uint8_t> frame(sizeof(std::uint32_t) + msg_len);
      std::uint32_t len32 = static_cast<std::uint32_t>(msg_len);
      std::memcpy(frame.data(), &len32, sizeof(len32));
      circular_buffer_peek(&sock->input_buffer, 0, frame.data() + sizeof(len32), msg_len);
      self->forward_log_frame(std::move(frame));
    };
    log_channel_->on_message<debug_logs_event>(forward);
    log_channel_->on_message<debug_spans_event>(forward);
    log_channel_->on_message<debug_metrics_event>(forward);

    socket_handlers::register_socket_handler(log_socket_, [self]() {
      self->handle_log_data();
    });
  }

  void recording::setup_store_session_messages() {
    // After rpc_*, register debug messages in same order as debug-store session API.
    store_session_client_->register_message_type<debug_snapshot_event>();
    store_session_client_->register_message_type<debug_io_event>();
    store_session_client_->register_message_type<debug_logs_event>();
    store_session_client_->register_message_type<debug_spans_event>();
    store_session_client_->register_message_type<debug_metrics_event>();
    store_session_client_->register_message_type<debug_bindings_event>();
    store_session_client_->register_message_type<debug_registry_event>();
    store_session_client_->register_message_type<debug_code_event>();
  }

  void recording::handle_monitor_data() {
    if(monitor_channel_) {
      monitor_channel_->handle_data();
    }
    flush_registry_refresh_queue();
  }

  void recording::handle_log_data() {
    if(log_channel_) {
      log_channel_->handle_data();
    }
  }

  void recording::forward_log_frame(std::vector<std::uint8_t> frame) {
    if(!store_session_client_ || state_ == recording_state::Stopping) return;
    auto* sock = get_socket_info(store_session_socket_);
    if(!sock) return;
    if(circular_buffer_writable_bytes(&sock->output_buffer) < frame.size()) {
      return;
    }
    circular_buffer_write(&sock->output_buffer, frame.data(), frame.size());
    waos_socket_flush(store_session_socket_);
  }

  void recording::on_io_frame(std::vector<std::uint8_t> frame) {
    if(state_ == recording_state::Starting || !has_anchor_) {
      return; // drop before first anchor
    }
    if(state_ == recording_state::Stopping) return;
    append_io_frame(std::move(frame));
    maybe_request_rotate();
  }

  void recording::on_save_event(std::uint64_t snapshot_uid, std::vector<std::uint8_t> /*frame*/) {
    if(state_ == recording_state::Starting || state_ == recording_state::RotatePending) {
      have_pending_event_ = true;
      pending_event_uid_ = snapshot_uid;
      // Cut point is current buffer end: drop everything up to here when the pair completes.
      // Do not keep the save-event frame in the I/O window (it would inflate the rotate threshold).
      pending_event_frame_end_ = io_bytes_.size();
      try_complete_cut();
      return;
    }
  }

  void recording::try_complete_cut() {
    if(!have_pending_result_ || !have_pending_event_) return;
    if(pending_result_.snapshot_uid != pending_event_uid_) return;

    if(state_ == recording_state::Starting) {
      io_bytes_.clear();
    } else if(pending_event_frame_end_ > 0 && pending_event_frame_end_ <= io_bytes_.size()) {
      // Drop the save-event frame and everything before it; keep only frames that
      // arrived after the cut point (start of the new window).
      size_t end = pending_event_frame_end_;
      std::vector<std::uint8_t> kept(
        io_bytes_.begin() + static_cast<std::ptrdiff_t>(end),
        io_bytes_.end()
      );
      io_bytes_ = std::move(kept);
    } else {
      io_bytes_.clear();
    }

    anchor_ = std::move(pending_result_);
    has_anchor_ = true;
    have_pending_result_ = false;
    have_pending_event_ = false;
    pending_event_frame_end_ = 0;
    state_ = recording_state::Idle;

    if(start_promise_) {
      start_promise_->resolve();
      start_promise_.reset();
    }
    if(rotate_promise_) {
      rotate_promise_->resolve();
      rotate_promise_.reset();
    }

    // Drop trailing incomplete bytes (host/kernel may leave a short residue).
    if(monitor_socket_) {
      auto* sock = get_socket_info(monitor_socket_);
      if(sock) {
        size_t left = circular_buffer_readable_bytes(&sock->input_buffer);
        if(left > 0 && left < sizeof(std::uint32_t)) {
          circular_buffer_skip_read(&sock->input_buffer, left);
        }
      }
    }
  }

  void recording::maybe_request_rotate() {
    if(state_ != recording_state::Idle || !has_anchor_) return;
    size_t threshold = static_cast<size_t>(request_.config.event_buffer_snapshot_mult) * anchor_.memory.size();
    if(threshold == 0) threshold = 1;
    if(io_bytes_.size() < threshold) return;

    state_ = recording_state::RotatePending;
    have_pending_result_ = false;
    have_pending_event_ = false;

    auto self = shared_from_this();
    auto p = shield_client::shield_rpc_client->save(request_.target_process);
    p->handle([self](save_result result) {
      self->have_pending_result_ = true;
      self->pending_result_ = std::move(result);
      self->try_complete_cut();
    }, [self](std::exception_ptr) {
      self->state_ = recording_state::Idle;
    });
  }

  void recording::on_error_event() {
    if(!request_.config.dump_on_error) return;
    if(!has_anchor_) return;
    if(state_ == recording_state::Dumping || state_ == recording_state::Stopping) return;
    // Fire-and-forget dump; keep session open
    dump_window();
  }

  std::shared_ptr<serialization::promise<void>> recording::send_io_blob(const std::vector<std::uint8_t>& bytes) {
    if(bytes.empty()) {
      return serialization::promise<void>::resolved();
    }
    size_t offset = 0;
    while(offset < bytes.size()) {
      size_t chunk = std::min(IO_CHUNK_SIZE, bytes.size() - offset);
      debug_io_event ev{};
      auto& writer = store_session_client_->channel().begin_send(ev);
      for(size_t i = 0; i < chunk; ++i) {
        writer.write_u8(bytes[offset + i]);
      }
      store_session_client_->channel().commit_send();
      offset += chunk;
    }
    return serialization::promise<void>::resolved();
  }

  void recording::send_bindings_payload(const std::vector<std::uint8_t>& bytes) {
    debug_bindings_event ev{};
    auto& writer = store_session_client_->channel().begin_send(ev);
    for(std::uint8_t b : bytes) {
      writer.write_u8(b);
    }
    store_session_client_->channel().commit_send();
  }

  void recording::send_code_payload(const std::vector<std::uint8_t>& bytes) {
    if(bytes.empty()) {
      return;
    }
    size_t offset = 0;
    while(offset < bytes.size()) {
      size_t chunk = std::min(IO_CHUNK_SIZE, bytes.size() - offset);
      debug_code_event ev{};
      auto& writer = store_session_client_->channel().begin_send(ev);
      for(size_t i = 0; i < chunk; ++i) {
        writer.write_u8(bytes[offset + i]);
      }
      store_session_client_->channel().commit_send();
      offset += chunk;
    }
  }

  void recording::send_registry_payload(
      std::uint64_t process_id,
      std::uint32_t socket_id,
      const std::vector<std::uint8_t>& bytes
  ) {
    debug_registry_event ev{
      .process_id = process_id,
      .socket_id = socket_id,
    };
    auto& writer = store_session_client_->channel().begin_send(ev);
    for(std::uint8_t b : bytes) {
      writer.write_u8(b);
    }
    store_session_client_->channel().commit_send();
  }

  void recording::queue_registry_refresh(std::uint64_t process_id, std::uint32_t socket_id) {
    pending_registry_refresh_.emplace_back(process_id, socket_id);
  }

  void recording::flush_registry_refresh_queue() {
    if(pending_registry_refresh_.empty()) return;
    auto pending = std::move(pending_registry_refresh_);
    pending_registry_refresh_.clear();
    for(const auto& [pid, sock] : pending) {
      refresh_peer_registry(pid, sock);
    }
  }

  std::shared_ptr<serialization::promise<void>> recording::refresh_peer_registry(
      std::uint64_t process_id,
      std::uint32_t socket_id
  ) {
    if(!store_session_client_ || state_ == recording_state::Stopping) {
      co_return;
    }
    // Must not nest shield RPCs inside another shield response handler — queue from
    // bind events and flush after monitor handle_data, or co_await from coroutines.
    auto self = shared_from_this();
    try {
      auto bytes = co_await shield_client::shield_rpc_client->get_rpc_description(process_id, socket_id);
      if(self->store_session_client_ && self->state_ != recording_state::Stopping) {
        self->send_registry_payload(process_id, socket_id, bytes);
      }
    } catch(...) {
      if(self->store_session_client_ && self->state_ != recording_state::Stopping) {
        self->send_registry_payload(process_id, socket_id, {});
      }
    }
    co_return;
  }

  std::shared_ptr<serialization::promise<void>> recording::capture_initial_topology() {
    if(!store_session_client_) {
      co_return;
    }

    auto target = request_.target_process;
    std::vector<kernel::socket_binding> bindings;
    try {
      bindings = co_await shield_client::shield_rpc_client->list_socket_bindings(target);
    } catch(...) {
      bindings.clear();
    }

    {
      bindings_snapshot snap{
        .process_id = target,
        .bindings = bindings,
      };
      send_bindings_payload(serialize_to_bytes(snap));
    }

    if(!request_.code.empty()) {
      send_code_payload(request_.code);
      request_.code.clear();
    }

    // Target socket 0: soft-fetch via shield (kernel soft OrEmpty — no process kill).
    {
      std::vector<std::uint8_t> bytes;
      try {
        bytes = co_await shield_client::shield_rpc_client->get_rpc_description(target, 0);
      } catch(...) {
        bytes.clear();
      }
      send_registry_payload(target, 0, bytes);
    }

    std::set<std::pair<std::uint64_t, std::uint32_t>> keys;
    for(const auto& b : bindings) {
      keys.emplace(target, static_cast<std::uint32_t>(b.socket));
      keys.emplace(b.peer_process, static_cast<std::uint32_t>(b.peer_socket));
    }
    keys.erase({target, 0});

    for(const auto& [pid, sock] : keys) {
      // Other local target sockets (e.g. KERNEL_API client end): empty placeholder —
      // they do not expose a public object API.
      if(pid == target) {
        send_registry_payload(pid, sock, {});
        continue;
      }
      std::vector<std::uint8_t> bytes;
      try {
        bytes = co_await shield_client::shield_rpc_client->get_rpc_description(pid, sock);
      } catch(...) {
        bytes.clear();
      }
      send_registry_payload(pid, sock, bytes);
    }

    co_return;
  }

  std::shared_ptr<serialization::promise<void>> recording::dump_window() {
    if(!has_anchor_ || !store_session_client_) {
      throw recorder_invalid_argument("no complete window to dump");
    }
    auto prev = state_;
    state_ = recording_state::Dumping;

    debug_snapshot_event snap{
      .snapshot_uid = anchor_.snapshot_uid,
      .mana_used = static_cast<std::uint64_t>(anchor_.mana_used),
      .mana_limit = static_cast<std::uint64_t>(anchor_.mana_limit),
    };
    {
      auto& writer = store_session_client_->channel().begin_send(snap);
      for(std::uint8_t b : anchor_.memory) {
        writer.write_u8(b);
      }
      store_session_client_->channel().commit_send();
    }

    co_await send_io_blob(io_bytes_);

    store_session_rpc<serialization::compressed_socket_rpc_client*> session_rpc(store_session_client_.get());
    co_await session_rpc.sync();

    if(state_ == recording_state::Dumping) {
      state_ = prev == recording_state::RotatePending ? recording_state::RotatePending : recording_state::Idle;
    }
    co_return;
  }

  std::shared_ptr<serialization::promise<void>> recording::dump() {
    if(state_ == recording_state::Stopping || state_ == recording_state::Starting) {
      throw recorder_invalid_argument("recording not ready for dump");
    }
    return dump_window();
  }

  std::shared_ptr<serialization::promise<void>> recording::rotate() {
    if(state_ != recording_state::Idle) {
      throw recorder_conflict("rotate only allowed in Idle state");
    }
    state_ = recording_state::RotatePending;
    have_pending_result_ = false;
    have_pending_event_ = false;
    rotate_promise_ = std::make_shared<serialization::promise<void>>();
    auto self = shared_from_this();
    auto done = rotate_promise_;
    auto p = shield_client::shield_rpc_client->save(request_.target_process);
    p->handle([self](save_result result) {
      self->have_pending_result_ = true;
      self->pending_result_ = std::move(result);
      self->try_complete_cut();
    }, [self](std::exception_ptr ex) {
      self->state_ = recording_state::Idle;
      if(self->rotate_promise_) {
        self->rotate_promise_->reject(ex);
        self->rotate_promise_.reset();
      }
    });
    return done;
  }

  std::shared_ptr<serialization::promise<void>> recording::stop() {
    state_ = recording_state::Stopping;

    close_socket(monitor_socket_);
    close_socket(log_socket_);
    close_socket(store_session_socket_);
    close_socket(store_user_socket_);

    monitor_channel_.reset();
    log_channel_.reset();
    store_session_client_.reset();
    store_user_client_.reset();

    erase_recording(recording_id_);
    co_return;
  }

  std::shared_ptr<serialization::promise<void>> recording::start() {
    start_promise_ = std::make_shared<serialization::promise<void>>();
    state_ = recording_state::Starting;

    // Bind to store USER and begin session
    store_user_socket_ = alloc_socket();
    open_socket(store_user_socket_);
    store_user_client_ = std::make_unique<serialization::compressed_socket_rpc_client>(store_user_socket_);
    store_user_client_->register_basic_types();
    {
      auto client_ptr = store_user_client_.get();
      socket_handlers::register_socket_handler(store_user_socket_, [client_ptr]() {
        client_ptr->handle_data();
      });
    }

    co_await shield_client::shield_rpc_client->bind(
      g_own_process_id, store_user_socket_,
      request_.store_process, 0,
      kernel::direction::BOTH
    );

    begin_session_request begin_req{
      .name = request_.session_name,
      .process_id = request_.target_process,
      .labels = request_.labels,
    };
    store_rpc<serialization::compressed_socket_rpc_client*> store(store_user_client_.get());
    auto begin_res = co_await store.begin(begin_req);
    store_session_id_ = begin_res.session_id;
    store_remote_session_socket_ = begin_res.store_socket;

    store_session_socket_ = alloc_socket();
    open_socket(store_session_socket_);
    store_session_client_ = std::make_unique<serialization::compressed_socket_rpc_client>(store_session_socket_);
    store_session_client_->register_basic_types();
    setup_store_session_messages();
    {
      auto client_ptr = store_session_client_.get();
      socket_handlers::register_socket_handler(store_session_socket_, [client_ptr]() {
        client_ptr->handle_data();
      });
    }

    co_await shield_client::shield_rpc_client->bind(
      g_own_process_id, store_session_socket_,
      request_.store_process, store_remote_session_socket_,
      kernel::direction::BOTH
    );

    monitor_socket_ = alloc_socket();
    open_socket(monitor_socket_);
    recordings_by_monitor[monitor_socket_] = shared_from_this();
    setup_monitor_channel();

    log_socket_ = alloc_socket();
    open_socket(log_socket_);
    recordings_by_log[log_socket_] = shared_from_this();
    setup_log_channel();

    co_await shield_client::shield_rpc_client->monitor(
      request_.target_process, g_own_process_id, monitor_socket_, build_monitor_config()
    );

    auto save_res = co_await shield_client::shield_rpc_client->save(request_.target_process);
    have_pending_result_ = true;
    pending_result_ = std::move(save_res);
    try_complete_cut();

    // Wait until save event completes the first anchor
    if(state_ == recording_state::Starting) {
      co_await start_promise_;
    } else {
      start_promise_.reset();
    }

    co_await capture_initial_topology();
    store_session_rpc<serialization::compressed_socket_rpc_client*> session_rpc(store_session_client_.get());
    co_await session_rpc.sync();
    co_return;
  }

}
