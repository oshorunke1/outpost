-- Operators are the humans who sign in. Service clients are machines (the game server now,
-- the MCP agent in M3) that trade an API key for a short-lived scoped token.
--
-- Emails are stored already normalized (trimmed, NFC, lowercased) by one shared helper in the
-- backend. The column uses a binary collation on purpose, so the unique index compares the exact
-- normalized bytes and the database never quietly merges or splits accounts on its own rules.
CREATE TABLE operators (
  operator_id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  token_version INT UNSIGNED NOT NULL DEFAULT 1,
  scopes JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_operators_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE service_clients (
  client_id VARCHAR(40) NOT NULL PRIMARY KEY,
  secret_hash VARCHAR(255) NOT NULL,
  scopes JSON NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL,
  rotated_at DATETIME(3) NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
