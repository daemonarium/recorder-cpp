#pragma once

#include <serialization/socket_rpc_client.hpp>
#include <serialization/promise.hpp>
#include <memory>
#include <vector>
#include <cstdint>
#include <examples/structures/kernel.hpp>

namespace waos {

  // Method IDs match kernel_shield API declaration order.
  template <typename rpc_client_ptr_type>
  class shield_rpc {
    public:
      using direction = kernel::direction;

      explicit shield_rpc(rpc_client_ptr_type rpc_client) : rpc_client_(rpc_client) {}

      std::shared_ptr<serialization::promise<void>> register_process(
          std::uint64_t id, std::uint64_t spawned_by, bool isolated) {
        return rpc_client_->template call<void>(4, id, spawned_by, isolated);
      }

      std::shared_ptr<serialization::promise<save_result>> save(std::uint64_t id) {
        return rpc_client_->template call<save_result>(6, id);
      }

      std::shared_ptr<serialization::promise<void>> bind(
          std::uint64_t process_from, std::uint64_t socket_from,
          std::uint64_t process_to, std::uint64_t socket_to,
          direction dir) {
        return rpc_client_->template call<void>(8, process_from, socket_from, process_to, socket_to, dir);
      }

      std::shared_ptr<serialization::promise<void>> unbind(
          std::uint64_t process_from, std::uint64_t socket_from,
          std::uint64_t process_to, std::uint64_t socket_to,
          direction dir) {
        return rpc_client_->template call<void>(9, process_from, socket_from, process_to, socket_to, dir);
      }

      std::shared_ptr<serialization::promise<void>> monitor(
          std::uint64_t target, std::uint64_t monitor, std::uint64_t monitor_socket,
          monitor_config config) {
        return rpc_client_->template call<void>(10, target, monitor, monitor_socket, config);
      }

      std::shared_ptr<serialization::promise<void>> demonitor(
          std::uint64_t target, std::uint64_t monitor, std::uint64_t monitor_socket) {
        return rpc_client_->template call<void>(11, target, monitor, monitor_socket);
      }

    private:
      rpc_client_ptr_type rpc_client_;
  };

  namespace shield_client {

    using rpc_client_type = serialization::socket_rpc_client;

    extern std::shared_ptr<rpc_client_type> rpc_client;
    extern std::shared_ptr<shield_rpc<rpc_client_type*>> shield_rpc_client;

    void start();

  }

}
