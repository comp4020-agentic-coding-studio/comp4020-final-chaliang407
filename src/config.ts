// Fly's only durable storage is the volume mounted at /data (fly.toml
// [mounts]); DATA_DIR is set to that in production and defaults to a local,
// gitignored directory for dev.
export const DATA_DIR = process.env.DATA_DIR ?? ".data";
export const DB_PATH = `${DATA_DIR}/game.db`;

// Not wired into round creation until a later iteration, but configurable
// from the start rather than hard-coded then.
export const ROUND_DURATION_MS = Number(process.env.ROUND_DURATION_MS ?? 3000);
