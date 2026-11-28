-- =====================================================================
-- 009_transaction_item_lines — urutan baris pada struk transaksi
-- `transaction_items` sebelumnya hanya bisa diurutkan berdasarkan `item_id`
-- (UUID acak), sehingga susunan barang di struk tidak mengikuti urutan input.
-- `line_no` menyimpan nomor baris seperti yang dicetak pada nota.
-- =====================================================================

ALTER TABLE transaction_items ADD COLUMN line_no integer;

-- Baris lama (hasil uji) dianggap satu baris pertama; kolom lalu diwajibkan.
UPDATE transaction_items SET line_no = 1 WHERE line_no IS NULL;
ALTER TABLE transaction_items ALTER COLUMN line_no SET DEFAULT 1;
ALTER TABLE transaction_items ALTER COLUMN line_no SET NOT NULL;

CREATE UNIQUE INDEX transaction_items_line_uidx ON transaction_items (transaction_id, line_no);
DROP INDEX IF EXISTS transaction_items_tx_idx;
CREATE INDEX transaction_items_tx_idx ON transaction_items (transaction_id, line_no);
