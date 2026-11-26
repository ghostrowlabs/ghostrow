-- Shop schema used by the tests and the golden output.
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  country_code CHAR(2) NOT NULL
);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  email VARCHAR(255) NOT NULL,
  nic VARCHAR(12) CHECK (length(nic) IN (10, 12)),
  phone VARCHAR(30),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'closed')),
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP,
  UNIQUE (tenant_id, email)
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  price NUMERIC(10, 2) NOT NULL CHECK (price > 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total NUMERIC(12, 2) NOT NULL,
  currency CHAR(3) NOT NULL,
  placed_at TIMESTAMP NOT NULL,
  shipped_at TIMESTAMP
);

CREATE TABLE order_lines (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 2) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL
);

CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  plan VARCHAR(10) NOT NULL,
  starts_at DATE NOT NULL,
  ends_at DATE NOT NULL,
  CHECK (ends_at > starts_at)
);
