---
name: tool-builder
description: 交互式创建和管理 Chat 模式的自定义 HTTP 工具。当用户想要创建新的 API 工具、配置 Chat 工具、添加自定义工具、管理自定义工具、或说"帮我创建一个 XX 工具"时使用此 Skill。也适用于调试、修复或删除已有的自定义工具。
version: "1.0.2"
---
# Tool Builder

Help users create custom HTTP API tools usable in Chat mode through interactive conversation.

## Workflow

### 1. Requirement Gathering

Ask the user about:
- The tool's purpose (weather lookup, translation, exchange rates, etc.)
- The API endpoint URL and authentication method
- Which parameters are needed (name, type, required or not)
- HTTP method (GET/POST)
- Which part of the response needs to be extracted

If the user is unsure about a specific API, help recommend a suitable public API.

### 2. Build the Configuration

Build the tool configuration JSON from the gathered information. The configuration file lives at `~/.profer/chat-tools.json`.

#### Configuration File Structure

```json
{
  "toolStates": {
    "memory": { "enabled": true },
    "web-search": { "enabled": false },
    "custom-weather": { "enabled": true }
  },
  "toolCredentials": {},
  "customTools": [
    {
      "id": "custom-weather",
      "name": "天气查询",
      "description": "查询指定城市的当前天气信息",
      "params": [
        { "name": "city", "type": "string", "description": "城市名称", "required": true }
      ],
      "category": "custom",
      "executorType": "http",
      "httpConfig": {
        "urlTemplate": "https://wttr.in/{{city}}?format=j1",
        "method": "GET",
        "resultPath": "current_condition"
      }
    }
  ]
}
```

#### ChatToolMeta Fields

| Field | Required | Description |
|------|------|------|
| `id` | Yes | Unique identifier, must be the `custom-` prefix + slug format (e.g. `custom-weather`) |
| `name` | Yes | Display name |
| `description` | Yes | Tool description; the AI decides when to call the tool based on it |
| `params` | Yes | Parameter list, each with `name`/`type`/`description`/`required` |
| `category` | Yes | Fixed to `"custom"` |
| `executorType` | Yes | Fixed to `"http"` |
| `httpConfig` | Yes | HTTP request configuration |
| `icon` | No | Lucide icon name (e.g. `"Cloud"`, `"Languages"`) |
| `systemPromptAppend` | No | System prompt injected when the tool is enabled |

#### httpConfig Fields

| Field | Required | Description |
|------|------|------|
| `urlTemplate` | Yes | URL template; `{{paramName}}` placeholders are replaced with parameter values (URL-encoded automatically) |
| `method` | Yes | `"GET"` or `"POST"` |
| `headers` | No | Request headers, commonly used for API Key authentication: `{ "Authorization": "Bearer xxx" }` |
| `bodyTemplate` | No | JSON template for the POST request body; `{{paramName}}` placeholders are replaced (not encoded) |
| `resultPath` | No | Dot path to extract a specific field from the response (e.g. `"data.results"`) |

#### Parameter Types

`params[].type` supports: `"string"` / `"number"` / `"boolean"`

Optionally add an `enum` field to restrict the allowed values:
```json
{ "name": "unit", "type": "string", "description": "温度单位", "enum": ["celsius", "fahrenheit"] }
```

### 3. Write the Configuration

Steps:
1. Read `~/.profer/chat-tools.json` (create it if it does not exist)
2. Append the new tool to the `customTools` array (deduplicate by `id`)
3. Add `{ "enabled": true }` in `toolStates` so it is enabled by default
4. Write the file back (keep the JSON formatted)

After writing, the app automatically detects the file change and refreshes the tool list.

### 4. Testing Guidance

Tell the user (in the user's language):
- "The tool has been created and enabled — please switch to Chat mode to test it"
- "You should see the new tool in the tool picker at the bottom-left of the Chat input box"
- "Try asking a question that needs this tool"
- "If anything goes wrong, come back to Agent mode and tell me — I'll help you debug it"

### 5. Debugging and Fixes

When the user reports problems, common causes:
- Wrong URL template → fix `urlTemplate`
- Incorrect parameter mapping → adjust the `params` definition
- Response format changed → update `resultPath`
- Authentication failure → check the API Key in `headers`
- Timeout → check API reachability

After fixing, write `chat-tools.json` again; the app refreshes automatically.

### 6. Deleting a Tool

Remove the tool from the `customTools` array and delete its entry from `toolStates`.

## Full Example: Weather Lookup Tool

```json
{
  "id": "custom-weather",
  "name": "天气查询",
  "description": "查询指定城市的当前天气和温度信息。当用户询问天气时调用。",
  "params": [
    { "name": "city", "type": "string", "description": "城市名称（英文）", "required": true }
  ],
  "category": "custom",
  "executorType": "http",
  "httpConfig": {
    "urlTemplate": "https://wttr.in/{{city}}?format=j1",
    "method": "GET",
    "resultPath": "current_condition"
  }
}
```

## Full Example: Translation Tool (POST + API Key)

```json
{
  "id": "custom-translate",
  "name": "翻译",
  "description": "将文本翻译为目标语言。当用户需要翻译时调用。",
  "params": [
    { "name": "text", "type": "string", "description": "要翻译的文本", "required": true },
    { "name": "target_lang", "type": "string", "description": "目标语言代码", "required": true, "enum": ["EN", "ZH", "JA", "KO", "FR", "DE", "ES"] }
  ],
  "category": "custom",
  "executorType": "http",
  "httpConfig": {
    "urlTemplate": "https://api.example.com/translate",
    "method": "POST",
    "headers": { "Authorization": "Bearer YOUR_API_KEY" },
    "bodyTemplate": "{\"text\": \"{{text}}\", \"target_lang\": \"{{target_lang}}\"}",
    "resultPath": "translations.0.text"
  }
}
```

## Output Language

All user-facing output — including the tool's display name, description, and parameter descriptions shown to the user, as well as every message you send to the user — must be written in the user's language (e.g., Simplified Chinese when the user writes in Chinese).
