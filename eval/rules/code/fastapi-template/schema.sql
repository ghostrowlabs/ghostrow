-- Written by hand for the held-out set from full-stack-fastapi-template backend/app/models.py (the table=True classes).
CREATE TABLE "user" (id uuid PRIMARY KEY, email varchar(255) NOT NULL UNIQUE, is_active boolean NOT NULL, is_superuser boolean NOT NULL, full_name varchar(255), hashed_password text NOT NULL, created_at timestamp);
CREATE TABLE item (id uuid PRIMARY KEY, title varchar(255) NOT NULL, description varchar(255), owner_id uuid NOT NULL REFERENCES "user"(id), created_at timestamp);
