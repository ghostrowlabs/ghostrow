"""Build a platform wheel that ships the Ghostrow standalone binary (standard library only).

    python build_wheels.py --version 1.0.0 --binary dist/standalone/ghostrow --platform manylinux_2_28_x86_64 --out wheels

Platform tags: manylinux_2_28_x86_64, manylinux_2_28_aarch64, macosx_13_0_arm64,
macosx_13_0_x86_64, win_amd64, win_arm64.
"""

import argparse
import base64
import hashlib
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # the cli/ folder

README = """# Ghostrow

Ghostrow turns a database schema into realistic, consistent test data that contains no real
personal data. It runs offline, is seeded so output is repeatable, and works with Postgres,
MySQL, SQL Server and SQLite.

This package installs the Ghostrow command line tool. It bundles the program, so Node.js is not
needed.

```sh
pip install ghostrow
ghostrow --version
ghostrow seed --schema schema.sql --dry-run
ghostrow seed --schema schema.sql --seed 42 --rows 5000 --out fixtures/
```

Free works without a key. Plus, Pro and Max need a license from https://ghostrow.com; activate
it with `ghostrow activate <key>`.

Documentation: https://ghostrow.com/docs/quickstart
License: proprietary, see https://ghostrow.com/legal/eula
"""

ENTRY_POINTS = "[console_scripts]\nghostrow = ghostrow.__main__:main\n"


def record_hash(data):
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    version = args.version
    is_windows = args.platform.startswith("win")
    bin_name = "ghostrow.exe" if is_windows else "ghostrow"
    dist_info = "ghostrow-%s.dist-info" % version

    with open(args.binary, "rb") as f:
        binary = f.read()
    with open(os.path.join(HERE, "ghostrow", "__main__.py"), "rb") as f:
        main_py = f.read()
    init_py = (
        '"""Ghostrow: realistic, consistent test data from your database schema."""\n\n'
        '__version__ = "%s"\n' % version
    ).encode("utf-8")

    metadata = (
        "Metadata-Version: 2.1\n"
        "Name: ghostrow\n"
        "Version: %s\n"
        "Summary: Realistic, consistent test data from your database schema. Offline, seeded, no real personal data.\n"
        "Home-page: https://ghostrow.com\n"
        "Author: Ghostrow Labs LLC\n"
        "License: Proprietary (https://ghostrow.com/legal/eula)\n"
        "Requires-Python: >=3.8\n"
        "Description-Content-Type: text/markdown\n"
        "\n"
        "%s" % (version, README)
    ).encode("utf-8")
    wheel = (
        "Wheel-Version: 1.0\n"
        "Generator: ghostrow-build\n"
        "Root-Is-Purelib: false\n"
        "Tag: py3-none-%s\n" % args.platform
    ).encode("utf-8")

    files = [
        ("ghostrow/__init__.py", init_py, 0o644),
        ("ghostrow/__main__.py", main_py, 0o644),
        ("ghostrow/bin/" + bin_name, binary, 0o755),
        (dist_info + "/METADATA", metadata, 0o644),
        (dist_info + "/WHEEL", wheel, 0o644),
        (dist_info + "/entry_points.txt", ENTRY_POINTS.encode("utf-8"), 0o644),
    ]

    record_lines = ["%s,%s,%d" % (name, record_hash(data), len(data)) for name, data, _ in files]
    record_lines.append(dist_info + "/RECORD,,")
    record = ("\n".join(record_lines) + "\n").encode("utf-8")
    files.append((dist_info + "/RECORD", record, 0o644))

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "ghostrow-%s-py3-none-%s.whl" % (version, args.platform))
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data, mode in files:
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # unix, so external_attr carries the file mode
            info.external_attr = (0o100000 | mode) << 16
            zf.writestr(info, data)
    print("wrote " + out_path)


if __name__ == "__main__":
    main()
