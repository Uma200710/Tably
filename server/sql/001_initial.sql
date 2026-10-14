CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  table_count INTEGER NOT NULL CHECK (table_count BETWEEN 1 AND 200),
  plan TEXT NOT NULL DEFAULT 'base' CHECK (plan IN ('base', 'ampliado')),
  subscription_status TEXT NOT NULL DEFAULT 'trial',
  subscription_id TEXT,
  subscription_due_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  subscription_paid_at TIMESTAMPTZ,
  mp_user_id TEXT UNIQUE,
  mp_access_token_enc TEXT,
  mp_refresh_token_enc TEXT,
  mp_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS subscription_due_at TIMESTAMPTZ;
UPDATE restaurants SET subscription_due_at = CASE
  WHEN subscription_status = 'authorized' THEN NOW() + INTERVAL '30 days'
  ELSE created_at + INTERVAL '30 days'
END WHERE subscription_due_at IS NULL;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS subscription_paid_at TIMESTAMPTZ;
ALTER TABLE restaurants ALTER COLUMN subscription_due_at SET DEFAULT (NOW() + INTERVAL '30 days');
ALTER TABLE restaurants ALTER COLUMN subscription_due_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_ars INTEGER NOT NULL CHECK (price_ars >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS menu_items_restaurant_idx ON menu_items(restaurant_id, active);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_number INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('mercadopago', 'cash', 'card')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'approved', 'rejected', 'refunded')),
  order_status TEXT NOT NULL DEFAULT 'received' CHECK (order_status IN ('received', 'preparing', 'ready', 'delivered', 'cancelled')),
  items JSONB NOT NULL,
  total_ars INTEGER NOT NULL CHECK (total_ars > 0),
  mp_preference_id TEXT,
  mp_payment_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_restaurant_created_idx ON orders(restaurant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_number INTEGER NOT NULL CHECK (table_number BETWEEN 1 AND 200),
  is_occupied BOOLEAN NOT NULL DEFAULT FALSE,
  occupied_at TIMESTAMPTZ,
  PRIMARY KEY (restaurant_id, table_number)
);

INSERT INTO restaurant_tables (restaurant_id, table_number, is_occupied, occupied_at)
SELECT restaurants.id, table_numbers.table_number,
       active_orders.occupied_at IS NOT NULL, active_orders.occupied_at
FROM restaurants
CROSS JOIN LATERAL generate_series(1, restaurants.table_count) AS table_numbers(table_number)
LEFT JOIN (
  SELECT restaurant_id, table_number, MIN(created_at) AS occupied_at
  FROM orders
  WHERE order_status IN ('received', 'preparing', 'ready') OR payment_status = 'pending'
  GROUP BY restaurant_id, table_number
) AS active_orders ON active_orders.restaurant_id = restaurants.id
  AND active_orders.table_number = table_numbers.table_number
ON CONFLICT (restaurant_id, table_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
