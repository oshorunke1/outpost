-- Stream entry ids the worker has already rolled up. Written in the same transaction as the
-- rollup, so a redelivered entry is recognised and skipped. Pruned after 24 hours. A stream id is
-- two 64 bit numbers joined by a dash, so it is at most 41 characters. Every identifier column is
-- utf8mb4_bin, like migrations 001 to 003, so keys compare as exact bytes.
CREATE TABLE telemetry_processed (
  entry_id VARCHAR(41) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  processed_at DATETIME(3) NOT NULL,
  KEY ix_telemetry_processed_at (processed_at)
) ENGINE = InnoDB;

-- Per minute aggregates. Raw events are never stored long term (ADR 0009).
CREATE TABLE telemetry_rollups (
  metric VARCHAR(32) COLLATE utf8mb4_bin NOT NULL,
  bucket_start DATETIME NOT NULL,
  dims_hash CHAR(64) COLLATE utf8mb4_bin NOT NULL,
  dims JSON NOT NULL,
  event_count BIGINT UNSIGNED NOT NULL,
  value_sum DOUBLE NOT NULL,
  PRIMARY KEY (metric, bucket_start, dims_hash)
) ENGINE = InnoDB;
