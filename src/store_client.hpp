#pragma once

#include <serialization/socket_rpc_client.hpp>
#include <serialization/promise.hpp>
#include <memory>
#include <cstdint>
#include <string>
#include <examples/structures/debug_store.hpp>

namespace waos {

  template <typename rpc_client_ptr_type>
  class store_rpc {
    public:
      explicit store_rpc(rpc_client_ptr_type rpc_client) : rpc_client_(rpc_client) {}

      std::shared_ptr<serialization::promise<begin_session_result>> begin(begin_session_request request) {
        return rpc_client_->template call<begin_session_result>(0, request);
      }

    private:
      rpc_client_ptr_type rpc_client_;
  };

  template <typename rpc_client_ptr_type>
  class store_session_rpc {
    public:
      explicit store_session_rpc(rpc_client_ptr_type rpc_client) : rpc_client_(rpc_client) {}

      std::shared_ptr<serialization::promise<void>> sync() {
        return rpc_client_->template call<void>(1);
      }

      std::shared_ptr<serialization::promise<void>> seal() {
        return rpc_client_->template call<void>(2);
      }

      std::shared_ptr<serialization::promise<void>> fail(std::string error) {
        return rpc_client_->template call<void>(3, error);
      }

      serialization::socket_rpc_client* client() { return rpc_client_; }

    private:
      rpc_client_ptr_type rpc_client_;
  };

}
