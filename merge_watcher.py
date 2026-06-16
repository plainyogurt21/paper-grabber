#!/usr/bin/env python3
"""
merge_watcher.py — watches your Downloads folder for paper-grabber folders
and auto-merges all PDFs inside into a single merged PDF.

Usage:
    python3 merge_watcher.py                    # watches ~/Downloads
    python3 merge_watcher.py ~/Desktop/papers   # watches a custom folder

How it works:
    1. Paper Grabber extension downloads files into ~/Downloads/Author_Year_Title/
    2. This script detects when a new file lands in any subfolder of Downloads
    3. After a short settle delay (no new files for 3s), it merges all PDFs in
       that folder into Author_Year_Title_merged.pdf (placed in the same folder)
    4. Prints a line when done — that's it
"""

import sys
import time
import threading
from pathlib import Path

try:
    from pypdf import PdfWriter, PdfReader
except ImportError:
    print("pypdf not found. Run: pip3 install pypdf")
    sys.exit(1)

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
except ImportError:
    print("watchdog not found. Run: pip3 install watchdog")
    sys.exit(1)


SETTLE_SECONDS = 3      # wait this long after last file write before merging
MERGED_SUFFIX  = "_merged.pdf"


def merge_folder(folder: Path):
    """Merge all PDFs in folder into folder/baseName_merged.pdf"""
    pdfs = sorted(f for f in folder.iterdir()
                  if f.suffix.lower() == '.pdf' and not f.name.endswith(MERGED_SUFFIX))

    if not pdfs:
        return

    merged_path = folder / f"{folder.name}{MERGED_SUFFIX}"

    # Skip if merged file is already up to date
    if merged_path.exists():
        merged_mtime = merged_path.stat().st_mtime
        if all(p.stat().st_mtime <= merged_mtime for p in pdfs):
            return

    writer = PdfWriter()
    added = []
    for pdf in pdfs:
        try:
            writer.append(str(pdf))
            added.append(pdf.name)
        except Exception as e:
            print(f"  ⚠ skipped {pdf.name}: {e}")

    if not added:
        return

    with open(merged_path, "wb") as f:
        writer.write(f)

    print(f"✓ merged {len(added)} PDF(s) → {merged_path.name}")
    for name in added:
        print(f"    {name}")


class PaperFolderHandler(FileSystemEventHandler):
    def __init__(self, watch_root: Path):
        self.watch_root = watch_root
        # folder → timer, so we debounce per folder
        self._timers: dict[Path, threading.Timer] = {}

    def _schedule_merge(self, folder: Path):
        # Cancel any pending timer for this folder and restart it
        if folder in self._timers:
            self._timers[folder].cancel()

        t = threading.Timer(SETTLE_SECONDS, self._do_merge, args=[folder])
        self._timers[folder] = t
        t.start()

    def _do_merge(self, folder: Path):
        self._timers.pop(folder, None)
        if folder.is_dir():
            merge_folder(folder)

    def on_created(self, event):
        self._handle(event.src_path)

    def on_modified(self, event):
        self._handle(event.src_path)

    def _handle(self, src_path: str):
        p = Path(src_path)
        # We only care about files inside a direct subfolder of watch_root
        # (i.e. watch_root/SomePaperFolder/file.pdf — depth 1 below root)
        try:
            rel = p.relative_to(self.watch_root)
        except ValueError:
            return

        parts = rel.parts
        if len(parts) < 2:
            return  # file directly in watch_root, not a paper subfolder

        folder = self.watch_root / parts[0]
        if folder.is_dir() and not parts[0].startswith('.'):
            self._schedule_merge(folder)


def main():
    watch_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads"
    watch_path = watch_path.expanduser().resolve()

    if not watch_path.is_dir():
        print(f"Directory not found: {watch_path}")
        sys.exit(1)

    print(f"Watching: {watch_path}")
    print(f"Will auto-merge PDFs {SETTLE_SECONDS}s after last download in each folder.")
    print("Press Ctrl+C to stop.\n")

    # Also merge any existing folders on startup
    for folder in watch_path.iterdir():
        if folder.is_dir() and not folder.name.startswith('.'):
            merge_folder(folder)

    handler = PaperFolderHandler(watch_path)
    observer = Observer()
    observer.schedule(handler, str(watch_path), recursive=True)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
