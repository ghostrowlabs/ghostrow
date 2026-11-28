-- Written by hand for the held-out set from jhipster-sample-app domain classes (@Table and @Column names).
CREATE TABLE jhi_user (id bigint PRIMARY KEY, login varchar(50) NOT NULL UNIQUE, password_hash varchar(60) NOT NULL, first_name varchar(50), last_name varchar(50), email varchar(254) UNIQUE, activated boolean NOT NULL, lang_key varchar(10), image_url varchar(256), activation_key varchar(20), reset_key varchar(20), reset_date timestamp, created_by varchar(50) NOT NULL, created_date timestamp, last_modified_by varchar(50), last_modified_date timestamp);
CREATE TABLE bank_account (id bigint PRIMARY KEY, name varchar(255) NOT NULL, balance numeric(21,2) NOT NULL, user_id bigint REFERENCES jhi_user(id));
CREATE TABLE label (id bigint PRIMARY KEY, label varchar(255) NOT NULL);
CREATE TABLE operation (id bigint PRIMARY KEY, date timestamp NOT NULL, description varchar(255), amount numeric(21,2) NOT NULL, bank_account_id bigint REFERENCES bank_account(id));
