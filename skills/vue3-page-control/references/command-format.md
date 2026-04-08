# Command Format

Send commands in one of these forms:

1. Tool input/output JSON object.
2. Markdown code fence with `copaw-web-skill`.
3. XML-style wrapper `<copaw-web-skill>...</copaw-web-skill>`.

Preferred payload:

```json
{
  "skill": "vue3-page-control",
  "action": "invoke_method",
  "commandId": "vue-control-20260408-001",
  "method": "setPageTitle",
  "args": {
    "title": "运营看板",
    "subtitle": "已根据会话指令更新"
  }
}
```

Notes:

- `commandId` should be unique for each execution request.
- `action` must be `invoke_method`.
- `args` can be an empty object when the method does not require inputs.
