CREATE TABLE big_table (
  id         bigint PRIMARY KEY,
  name       text NOT NULL,
  amount     numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL,
  is_active  boolean NOT NULL,
  tags       text[] NOT NULL,
  payload    jsonb NOT NULL,
  note       text
);

INSERT INTO big_table
SELECT i,
       'user_' || i,
       (i % 100000) / 100.0,
       timestamptz '2026-01-01 00:00:00+00' + i * interval '1 minute',
       i % 2 = 0,
       ARRAY['tag' || (i % 5), 'tag' || (i % 7)],
       jsonb_build_object('i', i, 'hash', md5(i::text), 'nested', jsonb_build_object('even', i % 2 = 0)),
       CASE WHEN i % 10 = 0 THEN NULL WHEN i % 10 = 5 THEN '' ELSE repeat('x', i % 200) END
FROM generate_series(1, 1000000) AS i;

ANALYZE big_table;
