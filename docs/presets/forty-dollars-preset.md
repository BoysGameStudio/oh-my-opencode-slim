# $40 Preset

This preset pairs **Claude Pro ($20/month)** with **ChatGPT Plus ($20/month)**.

It represents the powerhouse dual-subscription setup for developers holding both top-tier consumer plans, totaling **$40/month**.

- **Anthropic (Claude Pro)** handles high-level human interaction and visual aesthetics via `claude-opus-5-5` as **Orchestrator** and **Designer**, eliminating interrogation loops and stiff robotic hesitation.
- **OpenAI (ChatGPT Plus)** handles lightning-fast reconnaissance via `gpt-6-luna` (**Explorer**), adversarial architectural and bug scrutiny via `gpt-6-astra` (**Oracle**), and concrete code implementation via `gpt-6.1-sol` (**Fixer**).
- **Council** uses `gpt-6.1-sol` as the synthesizer, cross-examining competing verdicts between `gpt-6-astra` (Seat Alpha) and `claude-opus-5-5` (Seat Beta).

---

## The Config

```jsonc
{
  "preset": "fortydollars",
  "presets": {
    "fortydollars": {
      "orchestrator": {
        "model": "anthropic/claude-opus-5-5",
        "variant": "xhigh",
        "skills": [ "*" ],
        "mcps": [ "*" ]
      },
      "explorer": {
        "model": "openai/gpt-6-luna",
        "variant": "xhigh",
        "skills": [],
        "mcps": [ "context7", "gh_grep" ]
      },
      "oracle": {
        "model": "openai/gpt-6-astra",
        "variant": "max",
        "skills": [],
        "mcps": []
      },
      "council": {
        "model": "openai/gpt-6.1-sol",
        "variant": "max",
        "skills": [],
        "mcps": []
      },
      "designer": {
        "model": "anthropic/claude-opus-5-5",
        "variant": "high",
        "skills": [],
        "mcps": []
      },
      "fixer": {
        "model": "openai/gpt-6.1-sol",
        "variant": "xhigh",
        "skills": [],
        "mcps": []
      }
    }
  },
  "council": {
    "default_preset": "fortydollars",
    "presets": {
      "fortydollars": {
        "alpha": {
          "model": "openai/gpt-6-astra",
          "variant": "max"
        },
        "beta": {
          "model": "anthropic/claude-opus-5-5",
          "variant": "max"
        }
      }
    }
  }
}
```

## Skill Reference

| Skill | Description | Source |
| --- | --- | --- |
| `*` | All installed skills (wildcard) | `public` |

For the complete configuration reference, see [Configuration](../configuration.md).
