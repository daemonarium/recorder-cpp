#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <stdexcept>
#include <examples/structures/debug_store.hpp>

namespace waos {

  struct waosrec_registry {
    std::uint64_t process_id = 0;
    std::uint32_t socket_id = 0;
    binary bytes;
  };

  struct waosrec_manifest {
    std::uint32_t format_version = 1;
    session_meta session;
    snapshot_meta anchor;
  };

  struct waosrec_file {
    waosrec_manifest manifest;
    binary code;
    binary memory;
    binary events;
    bindings_snapshot bindings;
    std::vector<waosrec_registry> registries;
  };

  // Pack a debug-store session directory into a .waosrec blob.
  // Chooses the snapshot with the highest snapshot_uid. Throws if none.
  waosrec_file pack_session_dir(const std::string& session_dir);

  void write_waosrec_file(const std::string& path, const waosrec_file& file);
  waosrec_file read_waosrec_file(const std::string& path);

}
