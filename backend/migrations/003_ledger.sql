-- One row per money movement. The unique idempotency key makes a retried request find its first
-- result instead of paying twice; request_hash catches the same key reused for a different request.
-- result keeps the exact reply so a replay returns it unchanged.
--
-- Every identifier column is utf8mb4_bin, like migrations 001 and 002, so keys compare as exact
-- bytes: 'Order-1' and 'order-1' are two different idempotency keys (S3-F2), and the string
-- foreign keys match accounts.account_id, which is utf8mb4_bin too.
--
-- Lock order for writers (Task 14): lock the player's account_balances row FOR UPDATE by primary
-- key first (sorted by account_id when there is more than one), then insert here. The foreign keys
-- below take shared locks on the players and accounts rows, and fk_ledger_player stays for
-- integrity (S3-F3). The deadlock against player joins is avoided by that order together with a
-- rejoin that never locks the accounts or account_balances rows; withTransaction's bounded,
-- jittered retry on 1213 and 1205 is only the backstop.
CREATE TABLE ledger_transactions (
  transaction_id CHAR(36) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  idempotency_key VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  request_hash CHAR(64) COLLATE utf8mb4_bin NOT NULL,
  kind ENUM('earn', 'purchase', 'refund') NOT NULL,
  principal VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  roblox_user_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(32) COLLATE utf8mb4_bin NOT NULL,
  metadata JSON NOT NULL,
  refund_of CHAR(36) COLLATE utf8mb4_bin NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_ledger_idempotency_key (idempotency_key),
  UNIQUE KEY uq_ledger_refund_of (refund_of),
  KEY ix_ledger_user_created (roblox_user_id, created_at),
  CONSTRAINT fk_ledger_player FOREIGN KEY (roblox_user_id) REFERENCES players (roblox_user_id),
  CONSTRAINT fk_ledger_refund_of FOREIGN KEY (refund_of) REFERENCES ledger_transactions (transaction_id),
  CONSTRAINT chk_ledger_key_not_empty CHECK (CHAR_LENGTH(idempotency_key) > 0),
  CONSTRAINT chk_ledger_refund_of CHECK ((kind = 'refund') = (refund_of IS NOT NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Signed whole Coins. The entries of one transaction always sum to zero (double entry). Amounts
-- stay inside 2^53 - 1 so JavaScript reads them exactly.
CREATE TABLE ledger_entries (
  entry_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transaction_id CHAR(36) COLLATE utf8mb4_bin NOT NULL,
  account_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  amount BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_entries_transaction (transaction_id),
  KEY ix_entries_account (account_id, entry_id),
  CONSTRAINT fk_entries_transaction FOREIGN KEY (transaction_id) REFERENCES ledger_transactions (transaction_id),
  CONSTRAINT fk_entries_account FOREIGN KEY (account_id) REFERENCES accounts (account_id),
  CONSTRAINT chk_entries_not_zero CHECK (amount <> 0),
  CONSTRAINT chk_entries_safe_integer CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- The game's acknowledgement that it granted a purchased item. Kept apart from ledger_transactions
-- so the ledger itself never needs an UPDATE.
CREATE TABLE purchase_fulfillments (
  transaction_id CHAR(36) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  fulfilled_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_fulfillments_transaction FOREIGN KEY (transaction_id) REFERENCES ledger_transactions (transaction_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Wallet balances are read into JavaScript numbers too (S3-F12 b).
ALTER TABLE account_balances ADD CONSTRAINT chk_balance_safe_integer CHECK (balance <= 9007199254740991);

-- Invariant 5: ledger rows are never updated or deleted. Corrections are compensating transactions.
--
-- Triggers cannot stop TRUNCATE or DROP TABLE, which skip row triggers entirely. The API's MySQL
-- user must therefore hold only SELECT and INSERT on ledger_transactions, ledger_entries and
-- purchase_fulfillments, with no UPDATE, DELETE or DROP (S3-F12 c, documented in Task 33).
CREATE TRIGGER ledger_transactions_no_update BEFORE UPDATE ON ledger_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only';
CREATE TRIGGER ledger_transactions_no_delete BEFORE DELETE ON ledger_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only';
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only';
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only';

-- A fulfilment is written once and never changed. Task 14 replays it with a no-op
-- ON DUPLICATE KEY UPDATE, which fires this trigger, so an update that changes nothing passes.
CREATE TRIGGER purchase_fulfillments_no_update BEFORE UPDATE ON purchase_fulfillments FOR EACH ROW
  IF NOT (NEW.transaction_id <=> OLD.transaction_id AND NEW.fulfilled_at <=> OLD.fulfilled_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_fulfillments is insert-only';
  END IF;
CREATE TRIGGER purchase_fulfillments_no_delete BEFORE DELETE ON purchase_fulfillments FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase_fulfillments is insert-only';
