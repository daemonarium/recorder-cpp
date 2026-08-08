#include "shield_client.hpp"
#include "sockets.hpp"

#include <socket/socket.h>
#include <utils/socket_handlers.hpp>

namespace waos {
  namespace shield_client {

    std::shared_ptr<rpc_client_type> rpc_client;
    std::shared_ptr<shield_rpc<rpc_client_type*>> shield_rpc_client;

    void start() {
      struct socket_options socket_options = {
        .input_buffer_size = 65536,
        .output_buffer_size = 65536,
        .flush_threshold = 4096,
        .data_event_threshold = 0,
        .drain_event_threshold = 4,
        .flags = 0,
      };
      std::uint32_t socket_id = static_cast<std::uint32_t>(base_socket_id::SHIELD);
      socket_open(socket_id, &socket_options);

      rpc_client = std::make_shared<rpc_client_type>(socket_id);
      rpc_client->register_basic_types();
      // Match shield server exception registration so rpc_error payloads deserialize.
      rpc_client->channel().register_exception_type<std::runtime_error>();
      // save_result and monitor_config are plain objects; serialization uses reflection.
      shield_rpc_client = std::make_shared<shield_rpc<rpc_client_type*>>(rpc_client.get());

      auto client_ptr = rpc_client.get();
      socket_handlers::register_socket_handler(socket_id, [client_ptr]() {
        client_ptr->handle_data();
      });
    }

  }
}
