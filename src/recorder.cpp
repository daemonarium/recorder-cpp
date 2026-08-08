#include <serialization/stream_writer.hpp>
#include <serialization/socket_rpc_server.hpp>
#include <serialization/type_registry.hpp>
#include <serialization/type_description.hpp>
#include <utils/socket_handlers.hpp>
#include <socket/socket.h>
#include <memory>
#include <cstring>
#include <cstdlib>
#include <sstream>

#include "shield_client.hpp"
#include "rpc_registration.hpp"
#include "sockets.hpp"
#include "recording.hpp"

std::unique_ptr<serialization::socket_rpc_server> user_rpc_server_;

static size_t serialize_registry(serialization::type_registry& reg, char** buffer) {
  serialization::type_description::create(serialization::read_annotation(), reg);
  std::ostringstream output_stream;
  serialization::stream_writer writer(output_stream);

  writer.register_serialize_typed_function<serialization::type_description>();
  writer.register_serialize_typed_function<serialization::read_annotation>();

  serialize(writer, reg);
  writer.write_rest();

  *buffer = (char*)malloc(output_stream.str().size());
  memcpy(*buffer, output_stream.str().data(), output_stream.str().size());
  return output_stream.str().size();
}

size_t user_rpc_description(char** buffer) {
  waos::rpc_registration::active_registry = &waos::rpc_registration::registry;
  waos::rpc_registration::register_user_api(nullptr, true);
  return serialize_registry(waos::rpc_registration::registry, buffer);
}

extern "C" size_t rpc_description(std::uint32_t socket_id, char** buffer) {
  if(socket_id == static_cast<std::uint32_t>(base_socket_id::USER)) {
    return user_rpc_description(buffer);
  }
  return 0;
}

extern "C" void waos_socket_data(std::uint32_t socket) {
  socket_handlers::handle_socket_data(socket);
}

extern "C" void waos_socket_output_drain(int socket) {
  socket_handlers::handle_socket_drain(socket);
}

extern "C" void start() {
  sockets_init(128);

  waos::shield_client::start();

  struct socket_options socket_options = {
    // Large enough for start_recording.code (full module WASM) in one RPC frame.
    .input_buffer_size = 8 * 1024 * 1024,
    .output_buffer_size = 8 * 1024 * 1024,
    .flush_threshold = 4096,
    .data_event_threshold = 0,
    .drain_event_threshold = 4,
    .flags = 0,
  };

  socket_open(static_cast<std::uint32_t>(base_socket_id::USER), &socket_options);
  user_rpc_server_ = std::make_unique<serialization::socket_rpc_server>(
    static_cast<std::uint32_t>(base_socket_id::USER)
  );
  waos::rpc_registration::active_registry = &waos::rpc_registration::registry;
  waos::rpc_registration::register_user_api(user_rpc_server_.get(), true);

  auto server_ptr = user_rpc_server_.get();
  socket_handlers::register_socket_handler(static_cast<std::uint32_t>(base_socket_id::USER), [server_ptr]() {
    server_ptr->handle_data();
  });
}
