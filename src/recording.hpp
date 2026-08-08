#pragma once

#include <cstdint>
#include <memory>
#include <vector>
#include <string>
#include <unordered_map>
#include <examples/structures/recorder.hpp>
#include <examples/structures/kernel.hpp>
#include <examples/structures/debug_store.hpp>
#include <serialization/socket_message_channel.hpp>
#include <serialization/socket_rpc_client.hpp>
#include <serialization/promise.hpp>
#include "store_client.hpp"

namespace waos {

  enum class recording_state : std::uint8_t {
    Starting = 0,
    Idle = 1,
    RotatePending = 2,
    Dumping = 3,
    Stopping = 4,
  };

  extern std::uint64_t g_own_process_id;

  class recording : public std::enable_shared_from_this<recording> {
    public:
      recording(std::uint64_t recording_id, start_recording_request request);
      ~recording();

      std::uint64_t recording_id() const { return recording_id_; }
      std::uint32_t monitor_socket() const { return monitor_socket_; }
      std::uint32_t log_socket() const { return log_socket_; }
      std::uint64_t store_session_id() const { return store_session_id_; }
      std::uint32_t store_session_socket() const { return store_session_socket_; }
      recording_state state() const { return state_; }
      const std::vector<std::uint8_t>& io_bytes() const { return io_bytes_; }
      bool has_anchor() const { return has_anchor_; }
      const save_result& anchor() const { return anchor_; }

      std::shared_ptr<serialization::promise<void>> start();
      std::shared_ptr<serialization::promise<void>> dump();
      std::shared_ptr<serialization::promise<void>> rotate();
      std::shared_ptr<serialization::promise<void>> stop();

      void handle_monitor_data();
      void handle_log_data();

    private:
      std::uint64_t recording_id_;
      start_recording_request request_;
      recording_state state_ = recording_state::Starting;

      std::uint32_t store_user_socket_ = 0;
      std::uint32_t store_session_socket_ = 0;
      std::uint32_t monitor_socket_ = 0;
      std::uint32_t log_socket_ = 0;
      std::uint64_t store_session_id_ = 0;
      std::uint64_t store_remote_session_socket_ = 0;

      std::unique_ptr<serialization::socket_rpc_client> store_user_client_;
      std::unique_ptr<serialization::socket_rpc_client> store_session_client_;
      std::unique_ptr<serialization::socket_message_channel> monitor_channel_;
      std::unique_ptr<serialization::socket_message_channel> log_channel_;

      save_result anchor_{};
      bool has_anchor_ = false;
      std::vector<std::uint8_t> io_bytes_;

      // Pending halves for cut (Starting or RotatePending)
      bool have_pending_result_ = false;
      bool have_pending_event_ = false;
      save_result pending_result_{};
      std::uint64_t pending_event_uid_ = 0;
      size_t pending_event_frame_end_ = 0; // io_bytes offset after the save-event frame

      std::shared_ptr<serialization::promise<void>> start_promise_;
      std::shared_ptr<serialization::promise<void>> rotate_promise_;

      monitor_config build_monitor_config() const;
      std::uint32_t alloc_socket();
      void open_socket(std::uint32_t id);
      void close_socket(std::uint32_t id);
      void setup_monitor_channel();
      void setup_log_channel();
      void setup_store_session_messages();

      std::vector<std::uint8_t> capture_current_frame(size_t msg_len);
      void append_io_frame(std::vector<std::uint8_t> frame);
      void try_complete_cut();
      void maybe_request_rotate();
      std::shared_ptr<serialization::promise<void>> dump_window();
      std::shared_ptr<serialization::promise<void>> send_io_blob(const std::vector<std::uint8_t>& bytes);
      void send_bindings_payload(const std::vector<std::uint8_t>& bytes);
      void send_code_payload(const std::vector<std::uint8_t>& bytes);
      void send_registry_payload(std::uint64_t process_id, std::uint32_t socket_id, const std::vector<std::uint8_t>& bytes);
      std::shared_ptr<serialization::promise<void>> capture_initial_topology();
      void queue_registry_refresh(std::uint64_t process_id, std::uint32_t socket_id);
      void flush_registry_refresh_queue();
      std::shared_ptr<serialization::promise<void>> refresh_peer_registry(std::uint64_t process_id, std::uint32_t socket_id);
      void on_save_event(std::uint64_t snapshot_uid, std::vector<std::uint8_t> frame);
      void on_error_event();
      void on_io_frame(std::vector<std::uint8_t> frame);
      void forward_log_frame(std::vector<std::uint8_t> frame);

      std::vector<std::pair<std::uint64_t, std::uint32_t>> pending_registry_refresh_;
  };

  std::shared_ptr<recording> get_recording(std::uint64_t recording_id);
  std::shared_ptr<recording> get_recording_by_monitor_socket(std::uint32_t socket_id);
  std::shared_ptr<recording> get_recording_by_log_socket(std::uint32_t socket_id);
  std::shared_ptr<recording> create_recording(start_recording_request request);
  void erase_recording(std::uint64_t recording_id);

}
