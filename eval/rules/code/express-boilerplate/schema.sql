-- Written by hand for the held-out set from node-express-boilerplate src/models/user.model.js (a Mongoose model, as a table).
CREATE TABLE users (id char(24) PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, password text NOT NULL, role text NOT NULL, "isEmailVerified" boolean NOT NULL, "createdAt" timestamp, "updatedAt" timestamp);
