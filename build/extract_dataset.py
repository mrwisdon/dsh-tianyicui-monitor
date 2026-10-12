#!/usr/bin/env python3
"""Extract the real training data for the tianyicui monitor from a DSH git clone.

Sources (all real, no invented numbers):
  * `git log` over a shallow clone of deepseek-ai/deepseek-harness @master
      - `%ct` committer epoch, `%at` author epoch, `%an` author name
  * release instants parsed from `release(dsh): X.Y.Z` commits

Output: data/dataset.json  (compact, epoch-ms, ready for the plugin bundle)
"""
import subprocess, json, sys, os, datetime, collections

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
REPO = os.environ.get("DSH_GIT", os.path.join(_HERE, "dsh-git"))
OUT = os.environ.get("DSH_DATA_OUT", os.path.join(_ROOT, "data"))
TY_AUTHORS = {"tianyicui", "Tianyi Cui"}          # login + git author name
CST = datetime.timezone(datetime.timedelta(hours=8))


def git(*args):
    return subprocess.run(["git", "-C", REPO] + list(args),
                          capture_output=True, text=True, check=True).stdout


def main():
    # ---- commits: "<author_epoch> <committer_epoch> <author_name>" ----------
    raw = git("log", "--format=%at\t%ct\t%an")
    ty, allc = [], []
    author_counts = collections.Counter()
    for line in raw.split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        at, ct, an = int(parts[0]), int(parts[1]), parts[2]
        author_counts[an] += 1
        allc.append(ct * 1000)
        if an in TY_AUTHORS:
            ty.append(ct * 1000)

    # ---- releases: epoch of each version bump -----------------------------
    rel_raw = git("log", "--format=%ct\t%s")
    releases = []
    for line in rel_raw.split("\n"):
        if "\t" not in line:
            continue
        ct, subj = line.split("\t", 1)
        if not subj.startswith("release(dsh): "):
            continue
        ver = subj[len("release(dsh): "):].strip().split()[0]
        if not ver[0].isdigit():
            continue
        releases.append({"version": ver, "time": int(ct) * 1000})
    releases.sort(key=lambda r: r["time"])

    # dedupe versions, keep earliest instant per version
    seen, dedup = set(), []
    for r in releases:
        if r["version"] in seen:
            continue
        seen.add(r["version"])
        dedup.append(r)
    releases = dedup

    ty.sort()
    allc.sort()

    dataset = {
        "meta": {
            "repository": "deepseek-ai/deepseek-harness",
            "branch": "master",
            "author": "tianyicui",
            "authorNames": sorted(TY_AUTHORS),
            "generatedAt": int(datetime.datetime.now(tz=datetime.timezone.utc).timestamp() * 1000),
            "commitCountTianyicui": len(ty),
            "commitCountAll": len(allc),
            "releaseCount": len(releases),
            "firstCommitMs": min(allc),
            "lastCommitMs": max(allc),
            "lastCommitCst": datetime.datetime.fromtimestamp(max(allc) / 1000, CST).strftime("%Y-%m-%d %H:%M"),
            "topAuthors": author_counts.most_common(8),
        },
        "releases": releases,
        "tianyicuiCommits": ty,
        "allCommits": allc,
    }
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "dataset.json")
    with open(path, "w") as f:
        json.dump(dataset, f, separators=(",", ":"))

    m = dataset["meta"]
    print(f"tianyicui commits : {m['commitCountTianyicui']}")
    print(f"all commits       : {m['commitCountAll']}")
    print(f"releases (git)    : {m['releaseCount']}")
    print(f"hist span (CST)   : "
          f"{datetime.datetime.fromtimestamp(m['firstCommitMs']/1000, CST):%Y-%m-%d} -> {m['lastCommitCst']}")
    print(f"size              : {os.path.getsize(path)/1024:.0f} KiB -> {path}")


if __name__ == "__main__":
    main()
