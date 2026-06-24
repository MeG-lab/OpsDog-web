"""Runtime compatibility hooks for packaged Python scripts.

Python imports this module automatically when its directory is on PYTHONPATH.
Keep this file Python 3.6 compatible because CentOS 7 commonly ships that era
of Python 3 packages.
"""

import subprocess
import sys


if sys.version_info < (3, 7):
    _original_run = subprocess.run

    def _run_with_python37_keyword_compat(*popenargs, **kwargs):
        if "capture_output" in kwargs:
            capture_output = kwargs.pop("capture_output")
            if capture_output:
                if kwargs.get("stdout") is not None or kwargs.get("stderr") is not None:
                    raise ValueError(
                        "stdout and stderr arguments may not be used with capture_output"
                    )
                kwargs["stdout"] = subprocess.PIPE
                kwargs["stderr"] = subprocess.PIPE

        if "text" in kwargs:
            text_mode = kwargs.pop("text")
            if text_mode:
                kwargs["universal_newlines"] = True

        return _original_run(*popenargs, **kwargs)

    subprocess.run = _run_with_python37_keyword_compat
