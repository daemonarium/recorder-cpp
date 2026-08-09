#pragma once

#include <serialization/socket_rpc_server.hpp>
#include <serialization/type_registry.hpp>
#include <serialization/type_description.hpp>
#include <examples/structures/recorder.hpp>

namespace waos {
  namespace rpc_registration {

    extern serialization::type_registry registry;
    extern serialization::type_registry* active_registry;

    template <typename T>
    void register_rpc(serialization::compressed_socket_rpc_server* server, T& t, bool register_type = true) {
      #ifdef RPC_SERVER
      if(server) {
        server->register_recursive(t);
      }
      #endif

      #ifdef RPC_TYPE_DESCRIPTION
      if(register_type && active_registry) {
        active_registry->register_type(serialization::type_description::create(t, *active_registry));
      }
      #endif
    }

    template <typename T>
    void register_exception(serialization::compressed_socket_rpc_server* server, T& t, bool register_type = true) {
      #ifdef RPC_TYPE_DESCRIPTION
      if(register_type && active_registry) {
        active_registry->register_type(serialization::type_description::create(t, *active_registry));
      }
      #endif

      #ifdef RPC_SERVER
      if(server) {
        server->channel().register_exception_type<T>();
      }
      #endif
    }

    void register_user_api(serialization::compressed_socket_rpc_server* server, bool register_type = true);

  }
}
