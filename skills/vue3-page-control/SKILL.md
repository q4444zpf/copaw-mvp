---
name: vue3-page-control
description: Control Vue3 web pages through CoPaw by emitting structured web-skill commands that call front-end methods. Use when the user asks to update UI state, trigger page actions, or orchestrate view logic from chat.
---

# Vue3 Page Control Skill

Execute the workflow below.

## 1) Choose a front-end method

Pick one method from `references/method-catalog.md` that best matches the user goal.

If required arguments are missing, ask only for the minimum values needed to run that method.

## 2) Emit a web-skill command

Use tool name `vue3_page_control_dispatch`.

Use the JSON command format defined in `references/command-format.md`.

Always include:

- `skill: "vue3-page-control"`
- `action: "invoke_method"`
- `commandId` (unique per call)
- `method`
- `args`

## 3) Interpret execution result

After the Vue page executes the method and returns output:

- summarize what changed in the page state
- explain whether the requested control action was completed
- provide the next actionable step when needed

## 4) Safety boundaries

Do not invent unregistered front-end method names.

Do not claim execution succeeded before receiving a tool output/result event.
