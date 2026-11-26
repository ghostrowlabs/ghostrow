import { describe, expect, it } from "vitest";
import { detect } from "../../src/connect/load.js";
import { parseDjango, parseLaravel, parsePrisma, parseSqlAlchemy } from "../../src/connect/orm.js";
import type { TableModel } from "../../src/connect/types.js";

const tbl = (tables: TableModel[], name: string): TableModel => {
  const t = tables.find((x) => x.name === name);
  if (!t) throw new Error(`no table ${name}; have ${tables.map((x) => x.name).join(", ")}`);
  return t;
};
const col = (t: TableModel, name: string) => {
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw new Error(`no column ${name} in ${t.name}; have ${t.columns.map((x) => x.name).join(", ")}`);
  return c;
};

describe("parsePrisma", () => {
  const src = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  USER
}

model User {
  id      Int      @id @default(autoincrement())
  email   String   @unique @db.VarChar(120)
  name    String?
  role    Role     @default(USER)
  posts   Post[]
  profile Profile?
  @@map("users")
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int    @map("author_id")
  author   User   @relation(fields: [authorId], references: [id])
  slug     String
  @@unique([authorId, slug])
  @@map("blog_posts")
}

model Profile {
  id     String @id @default(uuid())
  bio    String?
  userId Int    @unique
  user   User   @relation(fields: [userId], references: [id])
}
`;
  const tables = parsePrisma(src);

  it("finds models and honours @@map", () => {
    expect(tables.map((t) => t.name).sort()).toEqual(["Profile", "blog_posts", "users"]);
  });

  it("reads @id and @default(autoincrement())", () => {
    const u = tbl(tables, "users");
    expect(u.primaryKey).toEqual(["id"]);
    const id = col(u, "id");
    expect(id.autoIncrement).toBe(true);
    expect(id.primaryKey).toBe(true);
    expect(id.nullable).toBe(false);
    expect(id.type).toBe("integer");
  });

  it("reads @unique and @db.VarChar(n)", () => {
    const email = col(tbl(tables, "users"), "email");
    expect(email.unique).toBe(true);
    expect(email.maxLength).toBe(120);
    expect(email.type).toBe("text");
  });

  it("makes optional fields nullable", () => {
    const u = tbl(tables, "users");
    expect(col(u, "name").nullable).toBe(true);
    expect(col(u, "email").nullable).toBe(false);
  });

  it("ignores list fields and relation fields as columns", () => {
    const u = tbl(tables, "users");
    expect(u.columns.map((c) => c.name)).toEqual(["id", "email", "name", "role"]);
  });

  it("reads enums", () => {
    const role = col(tbl(tables, "users"), "role");
    expect(role.type).toBe("enum");
    expect(role.enumValues).toEqual(["ADMIN", "USER"]);
  });

  it("applies @map on fields and @@unique with mapped column names", () => {
    const p = tbl(tables, "blog_posts");
    expect(p.columns.map((c) => c.name)).toContain("author_id");
    expect(p.uniques).toEqual([["author_id", "slug"]]);
  });

  it("turns @relation(fields, references) into a foreign key with mapped table names", () => {
    expect(tbl(tables, "blog_posts").foreignKeys).toEqual([{ columns: ["author_id"], refTable: "users", refColumns: ["id"] }]);
    expect(tbl(tables, "Profile").foreignKeys).toEqual([{ columns: ["userId"], refTable: "users", refColumns: ["id"] }]);
  });

  it("flags uuid defaults on string ids", () => {
    const id = col(tbl(tables, "Profile"), "id");
    expect(id.type).toBe("text");
    expect(id.defaultValue).toBeDefined();
  });

  it("supports composite @@id", () => {
    const t = parsePrisma(`model Pair {\n  a Int\n  b Int\n  @@id([a, b])\n}`);
    expect(t[0]!.primaryKey).toEqual(["a", "b"]);
  });

  it("maps Decimal, Boolean, DateTime and Json", () => {
    const t = parsePrisma(`model M {\n  id Int @id\n  d Decimal @db.Decimal(10, 2)\n  b Boolean\n  t DateTime\n  j Json\n}`)[0]!;
    expect(col(t, "d")).toMatchObject({ type: "decimal", precision: 10, scale: 2 });
    expect(col(t, "b").type).toBe("boolean");
    expect(col(t, "t").type).toBe("datetime");
    expect(col(t, "j").type).toBe("json");
  });
});

describe("parseDjango", () => {
  const src = `
from django.db import models
from django.core.validators import MinValueValidator


class Author(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField(unique=True)
    class Meta:
        db_table = "authors"


class Tag(models.Model):
    label = models.CharField(max_length=20)


class Kind(models.TextChoices):
    NOVEL = "novel", "Novel"
    POEM = "poem", "Poem"


class Book(models.Model):
    STATUS = [("draft", "Draft"), ("live", "Live")]

    title = models.CharField(max_length=200)
    contact = models.EmailField()
    price = models.DecimalField(max_digits=8, decimal_places=2)
    pages = models.PositiveIntegerField()
    rating = models.IntegerField(validators=[MinValueValidator(1)], null=True)
    author = models.ForeignKey(Author, on_delete=models.CASCADE)
    editor = models.ForeignKey("Author", null=True, on_delete=models.SET_NULL, related_name="edited")
    isbn = models.OneToOneField("Tag", on_delete=models.CASCADE)
    tags = models.ManyToManyField(Tag)
    status = models.CharField(max_length=10, choices=STATUS)
    kind = models.CharField(max_length=10, choices=Kind.choices)
    inline = models.CharField(max_length=5, choices=[("a", "A"), ("b", "B")])

    class Meta:
        unique_together = [("title", "author")]
`;
  const tables = parseDjango(src, "shelf");

  it("names tables <app>_<model> unless Meta.db_table is set", () => {
    expect(tables.map((t) => t.name).sort()).toEqual(["authors", "shelf_book", "shelf_book_tags", "shelf_tag"]);
  });

  it("adds an implicit auto-increment id", () => {
    const b = tbl(tables, "shelf_book");
    const id = col(b, "id");
    expect(id.primaryKey).toBe(true);
    expect(id.autoIncrement).toBe(true);
    expect(b.primaryKey).toEqual(["id"]);
  });

  it("reads CharField max_length, EmailField default 254 and unique", () => {
    const a = tbl(tables, "authors");
    expect(col(a, "name").maxLength).toBe(100);
    expect(col(a, "email").maxLength).toBe(254);
    expect(col(a, "email").unique).toBe(true);
    expect(col(a, "email").nullable).toBe(false);
  });

  it("reads DecimalField digits", () => {
    expect(col(tbl(tables, "shelf_book"), "price")).toMatchObject({ type: "decimal", precision: 8, scale: 2 });
  });

  it("maps ForeignKey to <field>_id plus an FK to <app>_<model>/db_table", () => {
    const b = tbl(tables, "shelf_book");
    expect(col(b, "author_id").nullable).toBe(false);
    expect(b.foreignKeys).toContainEqual({ columns: ["author_id"], refTable: "authors", refColumns: ["id"] });
    expect(col(b, "editor_id").nullable).toBe(true);
    expect(b.foreignKeys).toContainEqual({ columns: ["editor_id"], refTable: "authors", refColumns: ["id"] });
  });

  it("maps OneToOneField to a unique FK column", () => {
    const b = tbl(tables, "shelf_book");
    expect(col(b, "isbn_id").unique).toBe(true);
    expect(b.foreignKeys).toContainEqual({ columns: ["isbn_id"], refTable: "shelf_tag", refColumns: ["id"] });
  });

  it("creates a join table for ManyToManyField", () => {
    const j = tbl(tables, "shelf_book_tags");
    expect(j.columns.map((c) => c.name)).toEqual(["id", "book_id", "tag_id"]);
    expect(j.foreignKeys).toEqual([
      { columns: ["book_id"], refTable: "shelf_book", refColumns: ["id"] },
      { columns: ["tag_id"], refTable: "shelf_tag", refColumns: ["id"] },
    ]);
    expect(j.uniques).toEqual([["book_id", "tag_id"]]);
  });

  it("reads choices from an inline list, a named constant and a TextChoices class", () => {
    const b = tbl(tables, "shelf_book");
    expect(col(b, "inline")).toMatchObject({ type: "enum", enumValues: ["a", "b"] });
    expect(col(b, "status")).toMatchObject({ type: "enum", enumValues: ["draft", "live"] });
    expect(col(b, "kind")).toMatchObject({ type: "enum", enumValues: ["novel", "poem"] });
  });

  it("reads choices from a TextChoices class nested inside the model", () => {
    const src = [
      "from django.db import models",
      "",
      "class Book(models.Model):",
      "    class Kind(models.TextChoices):",
      '        NOVEL = "novel", "Novel"',
      '        POEM = "poem", "Poem"',
      "",
      "    title = models.CharField(max_length=200)",
      "    kind = models.CharField(max_length=10, choices=Kind.choices)",
    ].join("\n");
    const [t] = parseDjango(src, "library");
    const kind = t!.columns.find((c) => c.name === "kind")!;
    expect(kind.type).toBe("enum");
    expect(kind.enumValues).toEqual(["novel", "poem"]);
    expect(t!.columns.find((c) => c.name === "title")!.maxLength).toBe(200);
  });

  it("adds >= 0 for PositiveIntegerField and MinValueValidator checks", () => {
    const b = tbl(tables, "shelf_book");
    expect(b.checks).toContain("pages >= 0");
    expect(b.checks).toContain("rating >= 1");
  });

  it("reads Meta.unique_together", () => {
    expect(tbl(tables, "shelf_book").uniques).toEqual([["title", "author"]]);
  });

  it("skips abstract models", () => {
    const t = parseDjango(`from django.db import models\nclass Base(models.Model):\n    x = models.IntegerField()\n    class Meta:\n        abstract = True\n`, "a");
    expect(t).toEqual([]);
  });
});

describe("parseSqlAlchemy", () => {
  it("reads 1.x Column declarations", () => {
    const src = `
from sqlalchemy import Column, Integer, String, ForeignKey, UniqueConstraint, CheckConstraint, Boolean
from sqlalchemy.orm import declarative_base
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), nullable=False, unique=True)
    active = Column(Boolean, nullable=False)

class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    qty = Column(Integer)
    sku = Column(String(20))
    __table_args__ = (
        UniqueConstraint("user_id", "sku", name="uq_user_sku"),
        CheckConstraint("qty > 0", name="ck_qty"),
    )
`;
    const tables = parseSqlAlchemy(src);
    const u = tbl(tables, "users");
    expect(col(u, "id")).toMatchObject({ primaryKey: true, autoIncrement: true, nullable: false, type: "integer" });
    expect(col(u, "email")).toMatchObject({ maxLength: 255, nullable: false, unique: true });
    expect(col(u, "active").type).toBe("boolean");
    const o = tbl(tables, "orders");
    expect(o.foreignKeys).toEqual([{ columns: ["user_id"], refTable: "users", refColumns: ["id"] }]);
    expect(col(o, "user_id").nullable).toBe(false);
    expect(col(o, "qty").nullable).toBe(true);
    expect(o.uniques).toEqual([["user_id", "sku"]]);
    expect(o.checks).toEqual(["qty > 0"]);
  });

  it("reads 2.0 Mapped / mapped_column with Optional as nullable", () => {
    const src = `
from typing import Optional
from sqlalchemy import String, ForeignKey
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    nick: Mapped[Optional[str]] = mapped_column(String(50))
    handle: Mapped[str] = mapped_column(String(30), unique=True)
    nick2: Mapped[str | None] = mapped_column(String(10))
    owner_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
`;
    const a = tbl(parseSqlAlchemy(src), "accounts");
    expect(col(a, "id")).toMatchObject({ primaryKey: true, nullable: false });
    expect(col(a, "nick")).toMatchObject({ nullable: true, maxLength: 50 });
    expect(col(a, "handle")).toMatchObject({ nullable: false, unique: true, maxLength: 30 });
    expect(col(a, "nick2").nullable).toBe(true);
    expect(col(a, "owner_id").nullable).toBe(false);
    expect(a.foreignKeys).toEqual([{ columns: ["owner_id"], refTable: "accounts", refColumns: ["id"] }]);
  });

  it("reads core Table(name, metadata, Column(...))", () => {
    const src = `
from sqlalchemy import Table, Column, Integer, String, MetaData, ForeignKey
metadata = MetaData()
users = Table("users", metadata,
    Column("id", Integer, primary_key=True),
    Column("name", String(40), nullable=False),
)
posts = Table("posts", metadata,
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id")),
)
`;
    const tables = parseSqlAlchemy(src);
    expect(tables.map((t) => t.name).sort()).toEqual(["posts", "users"]);
    expect(col(tbl(tables, "users"), "name")).toMatchObject({ maxLength: 40, nullable: false });
    expect(tbl(tables, "posts").foreignKeys).toEqual([{ columns: ["user_id"], refTable: "users", refColumns: ["id"] }]);
  });
});

describe("parseLaravel", () => {
  const src = `<?php
use Illuminate\\Database\\Migrations\\Migration;
return new class extends Migration {
    public function up(): void {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->string('email')->unique();
            $table->foreignId('user_id')->constrained();
            $table->decimal('amount', 8, 2);
            $table->enum('status', ['new', 'paid']);
            $table->string('note', 100)->nullable();
            $table->boolean('flag')->default(false);
            $table->timestamps();
        });
    }
};
`;
  const t = tbl(parseLaravel(src), "orders");

  it("$table->id() is a bigint auto-increment primary key", () => {
    expect(col(t, "id")).toMatchObject({ primaryKey: true, autoIncrement: true, nullable: false, type: "integer", intBytes: 8 });
    expect(t.primaryKey).toEqual(["id"]);
  });

  it("string()->unique() has length 255 and unique", () => {
    expect(col(t, "email")).toMatchObject({ maxLength: 255, unique: true, nullable: false });
  });

  it("foreignId()->constrained() guesses the table from the column name", () => {
    expect(t.foreignKeys).toEqual([{ columns: ["user_id"], refTable: "users", refColumns: ["id"] }]);
  });

  it("decimal(amount, 8, 2)", () => {
    expect(col(t, "amount")).toMatchObject({ type: "decimal", precision: 8, scale: 2 });
  });

  it("enum with values", () => {
    expect(col(t, "status")).toMatchObject({ type: "enum", enumValues: ["new", "paid"] });
  });

  it("->nullable() and explicit length", () => {
    expect(col(t, "note")).toMatchObject({ nullable: true, maxLength: 100 });
  });

  it("timestamps() adds nullable created_at/updated_at", () => {
    expect(col(t, "created_at")).toMatchObject({ nullable: true, type: "datetime" });
    expect(col(t, "updated_at").nullable).toBe(true);
  });

  it("honours an explicit constrained table and a Schema::table block adds to the same table", () => {
    const tables = parseLaravel(`<?php
Schema::create('posts', function (Blueprint $table) { $table->id(); $table->foreignId('author_id')->constrained('people'); });
Schema::table('posts', function (Blueprint $table) { $table->string('slug')->unique(); });`);
    const p = tbl(tables, "posts");
    expect(p.foreignKeys).toEqual([{ columns: ["author_id"], refTable: "people", refColumns: ["id"] }]);
    expect(col(p, "slug").unique).toBe(true);
  });
});

describe("detect()", () => {
  it("recognises SQL by extension or content", () => {
    expect(detect("schema.sql", "")).toBe("sql");
    expect(detect("dump.txt", "create table t (id int);")).toBe("sql");
    expect(detect("notes.txt", "hello")).toBeNull();
  });
  it("recognises Prisma by extension or datasource block", () => {
    expect(detect("schema.prisma", "")).toBe("prisma");
    expect(detect("x.txt", 'datasource db {\n provider = "postgresql"\n}')).toBe("prisma");
  });
  it("recognises Django and SQLAlchemy python files", () => {
    expect(detect("models.py", "from django.db import models\nclass A(models.Model): pass")).toBe("django");
    expect(detect("models.py", 'class A(Base):\n    __tablename__ = "a"')).toBe("sqlalchemy");
    expect(detect("t.py", "metadata = None\nx = Table('a', metadata)")).toBe("sqlalchemy");
    expect(detect("util.py", "print('hi')")).toBeNull();
  });
  it("recognises Laravel migrations and ignores other PHP", () => {
    expect(detect("2024_create.php", "Schema::create('a', function () {});")).toBe("laravel");
    expect(detect("index.php", "<?php echo 1;")).toBeNull();
  });
});
