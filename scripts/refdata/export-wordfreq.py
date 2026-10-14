"""
Exports the English word-frequency list used by ref_word_frequency (docs/lookup-spec.md §2).

Run (from the repository root, inside the project's virtual environment):
    npm run refdata:wordfreq:export

Output: data/refdata/wordfreq-en.tsv   (UTF-8, LF, NO header; columns: word <TAB> zipf <TAB> rank)
  word  lowercase a-z, starts with a letter, a single apostrophe or hyphen is allowed BETWEEN letters
  zipf  zipf_frequency(word, 'en', wordlist='large') rounded to 2 decimals
  rank  1-based position in the ORIGINAL top_n_list (1 = most common). Filtering does NOT renumber:
        a gap in the ranks means a word that was dropped by the filter.
The script reads no network resource: wordfreq ships its data inside the package.
"""
import os
import re
import sys

from wordfreq import top_n_list, zipf_frequency

TOP_N = 200_000
WORDLIST = "large"
OUT_PATH = os.path.join("data", "refdata", "wordfreq-en.tsv")
# a-z only, starts with a letter, apostrophes / hyphens only between letters ("don't", "well-known")
WORD_RE = re.compile(r"^[a-z]+(?:['\-][a-z]+)*$")


def main() -> int:
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    words = top_n_list("en", TOP_N, wordlist=WORDLIST)

    written = 0
    first_lines = []
    # newline="\n" keeps LF on Windows so the file is identical on every platform
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as out:
        for rank, word in enumerate(words, start=1):
            if not WORD_RE.match(word):
                continue
            zipf = round(zipf_frequency(word, "en", wordlist=WORDLIST), 2)
            line = f"{word}\t{zipf:.2f}\t{rank}"
            out.write(line + "\n")
            written += 1
            if len(first_lines) < 5:
                first_lines.append(line)

    print(f"read {len(words)} words from top_n_list('en', {TOP_N}, wordlist='{WORDLIST}')")
    print(f"wrote {written} lines to {OUT_PATH}")
    print("first 5 lines (word, zipf, rank):")
    for line in first_lines:
        print("  " + line.replace("\t", "  |  "))
    return 0


if __name__ == "__main__":
    sys.exit(main())
