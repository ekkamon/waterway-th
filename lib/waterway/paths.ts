import path from "node:path";

// DATA_DIR keeps snapshots outside the build folder so a rebuild does not wipe history.
export const SNAPSHOT_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data", "snapshots");
