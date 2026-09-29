"""Generate test media into test/media/ with the uv-managed static ffmpeg (imageio-ffmpeg).

Usage: uv run --with imageio-ffmpeg python test/gen_media.py [--force] [--probe]
Cached: existing files are skipped unless --force.
"""
import pathlib, subprocess, sys
import imageio_ffmpeg

MEDIA = pathlib.Path(__file__).resolve().parent / "media"
FF = imageio_ffmpeg.get_ffmpeg_exe()

# name -> (seconds, tone Hz). Keyframe interval 50 frames (2 s) on purpose: a
# keyframe-snapping seek (fastSeek) would land visibly off target.
CLIPS = {"clip-5s.webm": (5, 440), "clip-3s.webm": (3, 660), "clip-2s.webm": (2, 880)}


def video_cmds(out, secs, hz):
    """Encode video and audio separately, then mux with stream copy.

    A single-pass mux shifts the video by the Opus pre-skip (first video block at
    7 ms, audio at -7 ms) and Chromium's MSE rejects the append with "Got a block
    with a timecode before the previous block". Muxing separate streams puts
    frame n exactly at n * 0.04 s and appends cleanly.
    """
    v, a = out.with_suffix(".v.tmp.webm"), out.with_suffix(".a.tmp.webm")
    return [
        [FF, "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", f"testsrc2=size=320x180:rate=25:duration={secs}",
         "-c:v", "libvpx-vp9", "-b:v", "150k", "-deadline", "good", "-cpu-used", "4",
         "-g", "50", "-keyint_min", "50", "-pix_fmt", "yuv420p", "-an", str(v)],
        [FF, "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", f"sine=frequency={hz}:sample_rate=48000:duration={secs}",
         "-c:a", "libopus", "-b:a", "32k", "-vn", str(a)],
        [FF, "-y", "-loglevel", "error", "-i", str(v), "-i", str(a),
         "-map", "0:v", "-map", "1:a", "-c", "copy", str(out)],
    ], [v, a]


def audio_cmd(out):
    return [FF, "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=8",
            "-c:a", "libopus", "-b:a", "32k", "-avoid_negative_ts", "make_zero", str(out)]


def probe(path):
    r = subprocess.run([FF, "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    lines = [l.strip() for l in r.stderr.splitlines() if "Duration" in l or "Stream #" in l]
    return lines


def main():
    force = "--force" in sys.argv
    MEDIA.mkdir(exist_ok=True)
    jobs = [(MEDIA / n, *video_cmds(MEDIA / n, s, hz)) for n, (s, hz) in CLIPS.items()]
    jobs.append((MEDIA / "audio-8s.webm", [audio_cmd(MEDIA / "audio-8s.webm")], []))
    for out, cmds, tmps in jobs:
        if out.exists() and out.stat().st_size > 0 and not force:
            continue
        print("generating", out.name)
        for cmd in cmds:
            subprocess.run(cmd, check=True)
        for tmp in tmps:
            tmp.unlink()
    if "--probe" in sys.argv:
        for out, *_ in jobs:
            print(f"{out.name}: {out.stat().st_size // 1024} KB")
            for l in probe(out):
                print("   ", l)


if __name__ == "__main__":
    main()
