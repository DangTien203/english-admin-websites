module.exports = [
  {
    file: 'services/lookup/lookupService.ts',
    edits: [
      [
        "  /** Work started after a response (job send, word_lookups insert) that has not finished yet. */\n  private readonly pending = new Set<Promise<void>>();",
        "  /** Work started after a response (job send, word_lookups insert) that has not finished yet. */\n  private readonly pending = new Set<Promise<void>>();\n  /** Words whose job send is running right now in this process (see sendOnce). */\n  private readonly sending = new Set<string>();",
      ],
      [
        "      if (enabled) this.afterResponse('enrich', input, () => this.sendIfTrusted(input, false, OUTAGE_JOB_DELAY_SECONDS));",
        "      if (enabled) this.sendOnce(input, () => this.sendIfTrusted(input, false, OUTAGE_JOB_DELAY_SECONDS));",
      ],
      [
        "    if (plan.send) this.afterResponse('enrich', input, () => this.sendJob(input));",
        "    if (plan.send) this.sendOnce(input, () => this.sendJob(input));",
      ],
      [
        "  /** Background: check the word, then send (used after a 503,",
        "  /**\n   * Starts a background send, unless one for the same word is already running in this process. A burst of lookups of one word\n   * (single-flight lets hundreds share one upstream call) would otherwise start one send each, all at once and with nobody waiting for\n   * them any more; the queue admits one job per word anyway (policy exclusive, spec §7), so the extra sends could only come back\n   * \"already_queued\". If the running send fails, the next lookup of the word sends again.\n   */\n  private sendOnce(input: LookupInput, work: () => Promise<void>): void {\n    const word = input.word.normalized;\n    if (this.sending.has(word)) return;\n    this.sending.add(word);\n    this.afterResponse('enrich', input, () => work().finally(() => this.sending.delete(word)));\n  }\n\n  /** Background: check the word, then send (used after a 503,",
      ],
    ],
  },
];
