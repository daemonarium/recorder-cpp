#include "waosrec.hpp"

#include <serialization/serialize.hpp>
#include <serialization/deserialize.hpp>
#include <serialization/stream_writer.hpp>
#include <serialization/stream_reader.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <regex>
#include <algorithm>

namespace waos {
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

    template <typename T>
    T deserialize_from_bytes(const std::vector<std::uint8_t>& bytes) {
      std::string s(bytes.begin(), bytes.end());
      std::istringstream iss(s);
      serialization::stream_reader reader(iss);
      T value{};
      deserialize(reader, value);
      reader.read_rest();
      return value;
    }

    std::vector<std::uint8_t> read_file_bytes(const fs::path& path) {
      std::ifstream in(path, std::ios::binary);
      if(!in) {
        throw std::runtime_error("failed to open " + path.string());
      }
      in.seekg(0, std::ios::end);
      auto size = in.tellg();
      in.seekg(0, std::ios::beg);
      if(size < 0) {
        throw std::runtime_error("failed to size " + path.string());
      }
      std::vector<std::uint8_t> bytes(static_cast<size_t>(size));
      if(size > 0) {
        in.read(reinterpret_cast<char*>(bytes.data()), size);
      }
      return bytes;
    }

    void write_file_bytes(const fs::path& path, const std::vector<std::uint8_t>& bytes) {
      std::ofstream out(path, std::ios::binary | std::ios::trunc);
      if(!out) {
        throw std::runtime_error("failed to write " + path.string());
      }
      if(!bytes.empty()) {
        out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
      }
    }

    std::vector<std::uint8_t> read_optional_file(const fs::path& path) {
      if(!fs::exists(path)) {
        return {};
      }
      return read_file_bytes(path);
    }

  }

  waosrec_file pack_session_dir(const std::string& session_dir) {
    fs::path dir(session_dir);
    if(!fs::is_directory(dir)) {
      throw std::runtime_error("session dir not found: " + session_dir);
    }

    waosrec_file out{};
    out.manifest.format_version = 1;
    out.manifest.session = deserialize_from_bytes<session_meta>(read_file_bytes(dir / "meta.bin"));

    std::uint64_t best_uid = 0;
    bool found_snap = false;
    const std::regex snap_re(R"(^snap\.(\d+)\.meta\.bin$)");
    for(const auto& entry : fs::directory_iterator(dir)) {
      if(!entry.is_regular_file()) continue;
      auto name = entry.path().filename().string();
      std::smatch match;
      if(!std::regex_match(name, match, snap_re)) continue;
      auto uid = static_cast<std::uint64_t>(std::stoull(match[1].str()));
      if(!found_snap || uid > best_uid) {
        best_uid = uid;
        found_snap = true;
      }
    }
    if(!found_snap) {
      throw std::runtime_error("no snap.<uid>.meta.bin in session dir");
    }

    out.manifest.anchor = deserialize_from_bytes<snapshot_meta>(
      read_file_bytes(dir / ("snap." + std::to_string(best_uid) + ".meta.bin"))
    );
    out.memory = read_file_bytes(dir / ("snap." + std::to_string(best_uid) + ".bin"));
    out.code = read_optional_file(dir / "code.wasm");
    out.events = read_optional_file(dir / "io.bin");

    auto bindings_path = dir / "bindings.bin";
    if(fs::exists(bindings_path)) {
      out.bindings = deserialize_from_bytes<bindings_snapshot>(read_file_bytes(bindings_path));
    }

    const std::regex registry_re(R"(^registry\.(\d+)\.(\d+)\.bin$)");
    for(const auto& entry : fs::directory_iterator(dir)) {
      if(!entry.is_regular_file()) continue;
      auto name = entry.path().filename().string();
      std::smatch match;
      if(!std::regex_match(name, match, registry_re)) continue;
      waosrec_registry reg{
        .process_id = static_cast<std::uint64_t>(std::stoull(match[1].str())),
        .socket_id = static_cast<std::uint32_t>(std::stoul(match[2].str())),
        .bytes = read_file_bytes(entry.path()),
      };
      out.registries.push_back(std::move(reg));
    }
    std::sort(out.registries.begin(), out.registries.end(), [](const auto& a, const auto& b) {
      if(a.process_id != b.process_id) return a.process_id < b.process_id;
      return a.socket_id < b.socket_id;
    });

    return out;
  }

  void write_waosrec_file(const std::string& path, const waosrec_file& file) {
    write_file_bytes(path, serialize_to_bytes(file));
  }

  waosrec_file read_waosrec_file(const std::string& path) {
    return deserialize_from_bytes<waosrec_file>(read_file_bytes(path));
  }

}
