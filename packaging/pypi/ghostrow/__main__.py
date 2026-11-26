"""Launch the bundled Ghostrow binary."""

import os
import stat
import subprocess
import sys


def _binary_path():
    name = "ghostrow.exe" if sys.platform == "win32" else "ghostrow"
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", name)


def main():
    path = _binary_path()
    if not os.path.isfile(path):
        sys.stderr.write("ghostrow: bundled binary not found at %s\n" % path)
        sys.exit(1)

    if sys.platform != "win32":
        mode = os.stat(path).st_mode
        if not mode & stat.S_IXUSR:
            try:
                os.chmod(path, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            except OSError:
                pass
        os.execv(path, [path] + sys.argv[1:])

    completed = subprocess.run([path] + sys.argv[1:])
    sys.exit(completed.returncode)


if __name__ == "__main__":
    main()
