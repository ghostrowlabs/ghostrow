-- The shop schema in MySQL dialect (ENUM, AUTO_INCREMENT, CHECK constraints need MySQL 8.0.16+).
CREATE TABLE tenants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  country_code CHAR(2) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  email VARCHAR(255) NOT NULL,
  nic VARCHAR(12),
  status ENUM('active', 'pending', 'closed') NOT NULL DEFAULT 'active',
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  UNIQUE KEY customers_tenant_email (tenant_id, email),
  CONSTRAINT customers_nic_len CHECK (CHAR_LENGTH(nic) IN (10, 12)),
  CONSTRAINT customers_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  total DECIMAL(12, 2) NOT NULL,
  placed_at DATETIME NOT NULL,
  shipped_at DATETIME NULL,
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE=InnoDB;

CREATE TABLE order_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  CONSTRAINT order_lines_qty CHECK (quantity > 0),
  CONSTRAINT order_lines_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB;
