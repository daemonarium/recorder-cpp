#include <examples/structures/recorder.hpp>
#include "recording.hpp"

namespace waos {

  std::shared_ptr<serialization::promise<start_recording_result>> recorder::start_recording(start_recording_request request) {
    if(request.config.event_buffer_snapshot_mult != 1 && request.config.event_buffer_snapshot_mult != 2) {
      throw recorder_invalid_argument("event_buffer_snapshot_mult must be 1 or 2");
    }
    if(request.session_name.empty()) {
      throw recorder_invalid_argument("session_name must be non-empty");
    }
    if(request.target_process == 0) {
      throw recorder_invalid_argument("target_process required");
    }
    if(request.store_process == 0) {
      throw recorder_invalid_argument("store_process required");
    }

    auto rec = create_recording(request);
    co_await rec->start();

    start_recording_result result;
    result.recording_id = rec->recording_id();
    result.monitor_socket = rec->monitor_socket();
    result.log_socket = rec->log_socket();
    result.store_session_id = rec->store_session_id();
    result.store_socket = rec->store_session_socket();
    co_return result;
  }

  std::shared_ptr<serialization::promise<void>> recorder::stop_recording(std::uint64_t recording_id) {
    auto rec = get_recording(recording_id);
    if(!rec) {
      throw recorder_not_found("recording not found");
    }
    co_await rec->stop();
    co_return;
  }

  std::shared_ptr<serialization::promise<void>> recorder::dump(std::uint64_t recording_id) {
    auto rec = get_recording(recording_id);
    if(!rec) {
      throw recorder_not_found("recording not found");
    }
    co_await rec->dump();
    co_return;
  }

  std::shared_ptr<serialization::promise<void>> recorder::rotate(std::uint64_t recording_id) {
    auto rec = get_recording(recording_id);
    if(!rec) {
      throw recorder_not_found("recording not found");
    }
    co_await rec->rotate();
    co_return;
  }

}
