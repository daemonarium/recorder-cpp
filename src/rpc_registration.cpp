#include "rpc_registration.hpp"

namespace waos {
  namespace rpc_registration {

    serialization::type_registry registry(true);
    serialization::type_registry* active_registry = &registry;

    static waos::recorder recorder_api;

    void register_user_api(serialization::socket_rpc_server* server, bool register_type) {
      if(server != nullptr) server->register_basic_types();

      waos::record_config cfg;
      register_rpc(server, cfg, register_type);
      waos::start_recording_request startReq;
      register_rpc(server, startReq, register_type);
      waos::start_recording_result startRes;
      register_rpc(server, startRes, register_type);

      register_rpc(server, recorder_api, register_type);

      waos::recorder_error e1;
      register_exception(server, e1, register_type);
      waos::recorder_invalid_argument e2;
      register_exception(server, e2, register_type);
      waos::recorder_not_found e3;
      register_exception(server, e3, register_type);
      waos::recorder_conflict e4;
      register_exception(server, e4, register_type);
      waos::recorder_closed e5;
      register_exception(server, e5, register_type);

      std::runtime_error runtimeEx("Runtime error");
      register_exception(server, runtimeEx, register_type);
    }

  }
}
