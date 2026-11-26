-- The shop schema in SQL Server dialect.
CREATE TABLE tenants (
  id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(120) NOT NULL,
  country_code CHAR(2) NOT NULL
);
CREATE TABLE customers (
  id INT IDENTITY(1,1) PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id),
  first_name NVARCHAR(60) NOT NULL,
  last_name NVARCHAR(60) NOT NULL,
  email NVARCHAR(255) NOT NULL,
  nic VARCHAR(12) NULL CHECK (LEN(nic) IN (10, 12)),
  is_verified BIT NOT NULL DEFAULT 0,
  external_id UNIQUEIDENTIFIER NOT NULL,
  created_at DATETIME2 NOT NULL,
  updated_at DATETIME2 NULL,
  CONSTRAINT customers_tenant_email UNIQUE (tenant_id, email)
);
CREATE TABLE orders (
  id INT IDENTITY(1,1) PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  total DECIMAL(12, 2) NOT NULL,
  placed_at DATETIME2 NOT NULL
);
CREATE TABLE order_lines (
  id INT IDENTITY(1,1) PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id),
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price DECIMAL(10, 2) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL
);
