#include <boost/ut.hpp>
#include <filesystem>
#include <fstream>
#include <unistd.h>

#include "waosrec.hpp"
#include <serialization/serialize.hpp>
#include <serialization/stream_writer.hpp>
#include <sstream>

using namespace boost::ut;
namespace fs = std::filesystem;

namespace {

  template <typename T>
  std::vector<std::uint8_t> serialize_to_bytes(const T& value) {
    std::ostringstream oss;
    serialization::stream_writer writer(oss);
    serialize(writer, value);
    writer.write_rest();
    std::string s = oss.str();
    return std::vector<std::uint8_t>(s.begin(), s.end());
  }

  void write_bytes(const fs::path& path, const std::vector<std::uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    expect(static_cast<bool>(out));
    if(!bytes.empty()) {
      out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }
  }

}

int main() {
  "pack_session_dir round-trips fixture sections"_test = [] {
    auto root = fs::temp_directory_path() / ("waosrec-fixture-" + std::to_string(::getpid()));
    fs::create_directories(root);
    auto guard = [&]() { fs::remove_all(root); };

    waos::session_meta meta{
      .name = "fixture",
      .process_id = 7,
      .status = "sealed",
      .error = "",
      .labels = {{"env", "test"}},
    };
    waos::snapshot_meta snap_meta{
      .snapshot_uid = 42,
      .mana_used = 1,
      .mana_limit = 100,
      .memory_size = 4,
    };
    waos::bindings_snapshot bindings{
      .process_id = 7,
      .bindings = {
        waos::kernel::socket_binding{
          .socket = 0,
          .peer_process = 9,
          .peer_socket = 1,
          .direction = waos::kernel::direction::BOTH,
        },
      },
    };
    std::vector<std::uint8_t> memory{1, 2, 3, 4};
    std::vector<std::uint8_t> code{0x00, 0x61, 0x73, 0x6d};
    std::vector<std::uint8_t> events{9, 8, 7};
    std::vector<std::uint8_t> registry{0xde, 0xad};

    write_bytes(root / "meta.bin", serialize_to_bytes(meta));
    write_bytes(root / "snap.10.meta.bin", serialize_to_bytes(waos::snapshot_meta{
      .snapshot_uid = 10, .mana_used = 0, .mana_limit = 0, .memory_size = 1
    }));
    write_bytes(root / "snap.10.bin", std::vector<std::uint8_t>{0});
    write_bytes(root / "snap.42.meta.bin", serialize_to_bytes(snap_meta));
    write_bytes(root / "snap.42.bin", memory);
    write_bytes(root / "bindings.bin", serialize_to_bytes(bindings));
    write_bytes(root / "code.wasm", code);
    write_bytes(root / "io.bin", events);
    write_bytes(root / "registry.7.0.bin", registry);

    auto packed = waos::pack_session_dir(root.string());
    expect(packed.manifest.format_version == 1_u);
    expect(packed.manifest.session.name == "fixture");
    expect(packed.manifest.anchor.snapshot_uid == 42_ull);
    expect(packed.code == code);
    expect(packed.memory == memory);
    expect(packed.events == events);
    expect(packed.bindings.bindings.size() == 1_u);
    expect(packed.bindings.bindings[0].peer_process == 9_u);
    expect(packed.registries.size() == 1_u);
    expect(packed.registries[0].bytes == registry);

    auto out = root / "out.waosrec";
    waos::write_waosrec_file(out.string(), packed);
    auto round = waos::read_waosrec_file(out.string());
    expect(round.manifest.session.name == packed.manifest.session.name);
    expect(round.code == packed.code);
    expect(round.memory == packed.memory);
    expect(round.events == packed.events);
    expect(round.bindings.bindings.size() == packed.bindings.bindings.size());
    expect(round.registries.size() == packed.registries.size());

    guard();
  };

  return 0;
}
