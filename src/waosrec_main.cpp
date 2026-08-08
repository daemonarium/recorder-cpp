#include "waosrec.hpp"

#include <serialization/type_registry.hpp>
#include <serialization/type_description.hpp>
#include <serialization/stream_writer.hpp>
#include <serialization/serialize.hpp>

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <stdexcept>

namespace {

  void print_usage(const char* argv0) {
    std::cerr
      << "Usage:\n"
      << "  " << argv0 << " pack <session-dir> -o <out.waosrec>\n"
      << "  " << argv0 << " info <file.waosrec>\n"
      << "  " << argv0 << " dump-registry -o <out.rpc_description.bin>\n";
  }

  int cmd_pack(int argc, char** argv) {
    std::string session_dir;
    std::string out_path;
    for(int i = 2; i < argc; ++i) {
      std::string arg = argv[i];
      if(arg == "-o") {
        if(i + 1 >= argc) {
          std::cerr << "missing value for -o\n";
          return 2;
        }
        out_path = argv[++i];
      } else if(session_dir.empty()) {
        session_dir = arg;
      } else {
        std::cerr << "unexpected argument: " << arg << "\n";
        return 2;
      }
    }
    if(session_dir.empty() || out_path.empty()) {
      print_usage(argv[0]);
      return 2;
    }

    auto packed = waos::pack_session_dir(session_dir);
    waos::write_waosrec_file(out_path, packed);
    std::cout
      << "packed session=" << packed.manifest.session.name
      << " snap=" << packed.manifest.anchor.snapshot_uid
      << " code=" << packed.code.size()
      << " memory=" << packed.memory.size()
      << " events=" << packed.events.size()
      << " registries=" << packed.registries.size()
      << " -> " << out_path << "\n";
    return 0;
  }

  int cmd_info(int argc, char** argv) {
    if(argc < 3) {
      print_usage(argv[0]);
      return 2;
    }
    auto file = waos::read_waosrec_file(argv[2]);
    std::cout
      << "format_version=" << file.manifest.format_version << "\n"
      << "session.name=" << file.manifest.session.name << "\n"
      << "session.process_id=" << file.manifest.session.process_id << "\n"
      << "session.status=" << file.manifest.session.status << "\n"
      << "anchor.snapshot_uid=" << file.manifest.anchor.snapshot_uid << "\n"
      << "anchor.memory_size=" << file.manifest.anchor.memory_size << "\n"
      << "code_bytes=" << file.code.size() << "\n"
      << "memory_bytes=" << file.memory.size() << "\n"
      << "events_bytes=" << file.events.size() << "\n"
      << "bindings_count=" << file.bindings.bindings.size() << "\n"
      << "registries=" << file.registries.size() << "\n";
    return 0;
  }

  int cmd_dump_registry(int argc, char** argv) {
    std::string out_path;
    for(int i = 2; i < argc; ++i) {
      std::string arg = argv[i];
      if(arg == "-o") {
        if(i + 1 >= argc) {
          std::cerr << "missing value for -o\n";
          return 2;
        }
        out_path = argv[++i];
      } else {
        std::cerr << "unexpected argument: " << arg << "\n";
        return 2;
      }
    }
    if(out_path.empty()) {
      print_usage(argv[0]);
      return 2;
    }

    serialization::type_registry registry(true);
    waos::waosrec_file root{};
    registry.register_type(serialization::type_description::create(root, registry));
    waos::session_meta session{};
    registry.register_type(serialization::type_description::create(session, registry));
    waos::snapshot_meta snap{};
    registry.register_type(serialization::type_description::create(snap, registry));
    waos::bindings_snapshot bindings{};
    registry.register_type(serialization::type_description::create(bindings, registry));

    serialization::type_description::create(serialization::read_annotation(), registry);
    std::ostringstream output_stream;
    serialization::stream_writer writer(output_stream);
    writer.register_serialize_typed_function<serialization::type_description>();
    writer.register_serialize_typed_function<serialization::read_annotation>();
    serialize(writer, registry);
    writer.write_rest();

    std::ofstream out(out_path, std::ios::binary | std::ios::trunc);
    if(!out) {
      throw std::runtime_error("failed to write " + out_path);
    }
    out << output_stream.str();
    std::cout << "wrote registry bytes=" << output_stream.str().size() << " -> " << out_path << "\n";
    return 0;
  }

}

int main(int argc, char** argv) {
  if(argc < 2) {
    print_usage(argv[0]);
    return 2;
  }
  try {
    std::string cmd = argv[1];
    if(cmd == "pack") return cmd_pack(argc, argv);
    if(cmd == "info") return cmd_info(argc, argv);
    if(cmd == "dump-registry") return cmd_dump_registry(argc, argv);
    print_usage(argv[0]);
    return 2;
  } catch(const std::exception& ex) {
    std::cerr << "error: " << ex.what() << "\n";
    return 1;
  }
}
