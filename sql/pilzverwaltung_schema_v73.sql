-- Pilzverwaltung Server-Version v73 - MySQL Datenbankplan
-- Grundlage: Pilzverwaltung Testversion v72

CREATE DATABASE IF NOT EXISTS pilzverwaltung CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pilzverwaltung;

CREATE TABLE users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','mitarbeiter','gast') NOT NULL DEFAULT 'mitarbeiter',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE strains (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  scientific_name VARCHAR(255) NOT NULL,
  german_name VARCHAR(255),
  shortcode VARCHAR(50),
  notes TEXT,
  UNIQUE KEY uq_strain_name (scientific_name)
);

CREATE TABLE woo_products (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(100) NOT NULL UNIQUE,
  product_name VARCHAR(255) NOT NULL,
  area VARCHAR(50),
  variant VARCHAR(100),
  woo_product_id BIGINT,
  woo_variation_id BIGINT,
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE master_cultures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  master_code VARCHAR(50) NOT NULL UNIQUE,
  strain_id BIGINT,
  source_type VARCHAR(50),
  source_item_code VARCHAR(80),
  created_date DATE,
  grain_spawn_status VARCHAR(100),
  liquid_culture_status VARCHAR(100),
  substrate_status VARCHAR(100),
  fruiting_status VARCHAR(100),
  dna_status VARCHAR(100),
  homepage_status VARCHAR(100),
  note TEXT,
  raw_json JSON,
  FOREIGN KEY (strain_id) REFERENCES strains(id)
);

CREATE TABLE permanent_cultures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  master_culture_id BIGINT,
  strain_id BIGINT,
  type VARCHAR(100),
  source TEXT,
  culture_date DATE,
  count_value INT DEFAULT 1,
  status VARCHAR(100),
  place VARCHAR(255),
  coords VARCHAR(100),
  wood VARCHAR(100),
  raw_json JSON,
  FOREIGN KEY (master_culture_id) REFERENCES master_cultures(id),
  FOREIGN KEY (strain_id) REFERENCES strains(id)
);

CREATE TABLE petri_dishes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  master_culture_id BIGINT,
  strain_id BIGINT,
  source_type VARCHAR(50),
  source_code VARCHAR(50),
  petri_date DATE,
  count_value INT DEFAULT 1,
  status VARCHAR(100),
  source_note TEXT,
  fundort VARCHAR(255),
  baumart VARCHAR(100),
  koordinaten VARCHAR(100),
  raw_json JSON,
  FOREIGN KEY (master_culture_id) REFERENCES master_cultures(id),
  FOREIGN KEY (strain_id) REFERENCES strains(id)
);

CREATE TABLE liquid_cultures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  strain_id BIGINT,
  source_type VARCHAR(50),
  source_code VARCHAR(50),
  lc_date DATE,
  bottle_count INT DEFAULT 1,
  volume_ml INT,
  status VARCHAR(100),
  woo_sku VARCHAR(100),
  raw_json JSON,
  FOREIGN KEY (strain_id) REFERENCES strains(id),
  FOREIGN KEY (woo_sku) REFERENCES woo_products(sku)
);

CREATE TABLE grain_spawn (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  strain_id BIGINT,
  source_type VARCHAR(50),
  source_code VARCHAR(50),
  spawn_date DATE,
  bag_count INT DEFAULT 1,
  size_value VARCHAR(50),
  status VARCHAR(100),
  woo_sku VARCHAR(100),
  raw_json JSON,
  FOREIGN KEY (strain_id) REFERENCES strains(id),
  FOREIGN KEY (woo_sku) REFERENCES woo_products(sku)
);

CREATE TABLE substrate_mixes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  ingredients TEXT,
  water_percent DECIMAL(5,2)
);

CREATE TABLE test_groups (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255),
  description TEXT,
  created_date DATE,
  raw_json JSON
);

CREATE TABLE substrate_bags (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  lot_code VARCHAR(80),
  strain_id BIGINT,
  source_type VARCHAR(50),
  source_code VARCHAR(50),
  mix_code VARCHAR(50),
  test_group_id BIGINT,
  bag_count INT DEFAULT 1,
  substrate_date DATE,
  weight_kg DECIMAL(8,2),
  water_percent DECIMAL(5,2),
  status VARCHAR(100),
  for_test BOOLEAN DEFAULT FALSE,
  test_name VARCHAR(255),
  test_description TEXT,
  raw_json JSON,
  FOREIGN KEY (strain_id) REFERENCES strains(id),
  FOREIGN KEY (test_group_id) REFERENCES test_groups(id)
);

CREATE TABLE harvests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  substrate_bag_id BIGINT,
  harvest_no INT,
  harvest_date DATE,
  weight_g DECIMAL(10,2),
  note TEXT,
  raw_json JSON,
  FOREIGN KEY (substrate_bag_id) REFERENCES substrate_bags(id)
);

CREATE TABLE buckets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  product VARCHAR(255),
  fill_date DATE,
  qty DECIMAL(10,2),
  unit VARCHAR(30),
  status VARCHAR(100),
  note TEXT,
  raw_json JSON
);

CREATE TABLE dried_lots (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  bucket_code VARCHAR(50),
  product VARCHAR(255),
  pack_date DATE,
  best_before DATE,
  pack_count INT DEFAULT 1,
  stock_count INT DEFAULT 1,
  status VARCHAR(100),
  woo_sku VARCHAR(100),
  raw_json JSON,
  FOREIGN KEY (woo_sku) REFERENCES woo_products(sku)
);

CREATE TABLE goods (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  goods_type ENUM('dowel','syringe','dowel_set') NOT NULL,
  strain_id BIGINT,
  source_type VARCHAR(50),
  source_code VARCHAR(50),
  product_date DATE,
  variant VARCHAR(100),
  quantity INT DEFAULT 1,
  stock_count INT DEFAULT 1,
  status VARCHAR(100),
  woo_sku VARCHAR(100),
  components_json JSON,
  raw_json JSON,
  FOREIGN KEY (strain_id) REFERENCES strains(id),
  FOREIGN KEY (woo_sku) REFERENCES woo_products(sku)
);

CREATE TABLE logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  strain_id BIGINT,
  source_type VARCHAR(50),
  source_code VARCHAR(50),
  wood VARCHAR(100),
  diameter_cm DECIMAL(8,2),
  length_cm DECIMAL(8,2),
  count_value INT DEFAULT 1,
  log_date DATE,
  status VARCHAR(100),
  woo_sku VARCHAR(100),
  raw_json JSON,
  FOREIGN KEY (strain_id) REFERENCES strains(id),
  FOREIGN KEY (woo_sku) REFERENCES woo_products(sku)
);

CREATE TABLE min_stocks (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  area VARCHAR(50) NOT NULL,
  product_or_strain VARCHAR(255),
  variant VARCHAR(100),
  woo_sku VARCHAR(100),
  min_qty INT DEFAULT 1,
  production_reserve INT DEFAULT 0,
  reserve_active BOOLEAN DEFAULT TRUE,
  raw_json JSON,
  FOREIGN KEY (woo_sku) REFERENCES woo_products(sku)
);

CREATE TABLE archive_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_date DATE,
  item_type VARCHAR(50),
  item_code VARCHAR(80),
  action VARCHAR(100),
  details TEXT,
  user_id BIGINT,
  raw_json JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE labels (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  area VARCHAR(50),
  item_code VARCHAR(80),
  qr_payload TEXT,
  printed BOOLEAN DEFAULT FALSE,
  printed_at DATE,
  UNIQUE KEY uq_label_item (area, item_code)
);

CREATE INDEX idx_substrate_status ON substrate_bags(status);
CREATE INDEX idx_goods_sku ON goods(woo_sku);
CREATE INDEX idx_dried_lots_sku ON dried_lots(woo_sku);
CREATE INDEX idx_archive_item ON archive_events(item_type, item_code);
