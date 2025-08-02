# Pipeline API

This document lists the REST endpoints used by the `PipelineEditor` UI.

### Load pipeline
`GET /pipelines/:id`
```
Response 200: {
  "name": string,
  "steps": PipelineStep[]
}
```

### Create pipeline
`POST /pipelines`
```
Request body: { "name": string, "steps": [] }
Response 201: { "id": UUID, "name": string, "steps": [] }
```

### Update pipeline name
`PUT /pipelines/:id`
```
Request body: { "name": string }
```

### Add step
`PUT /pipelines/:id/steps`
```
Request body: { "index": number, "step": PipelineStep }
```

### Edit step
`PATCH /pipelines/:id/steps/:stepId`
```
Request body: Partial<PipelineStep>
```

### Delete step
`DELETE /pipelines/:id/steps/:stepId`

### Update step order
`PUT /pipelines/:id/steps/order`
```
Request body: { "order": [stepId, ...] }
```

### Run pipeline
`POST /pipelines/:id/run`
```
Request body: { "file_id": number }
```

The call returns the result JSON when the pipeline has finished or
`202 Accepted` while waiting. A `pipeline-updated` event is sent after every
successful save (name, step or order change).

## Prompt Manager Endpoints

### List prompts
`GET /prompts?type=TYPE`

Optional query parameter `type` filters the returned prompts by their stored `PromptType`.
Each prompt item contains `text`, `type` and `weight` fields.

### Manage prompt groups
`GET /prompt-groups` – list groups

`POST /prompt-groups` – create a group

`PUT /prompt-groups/:id` – rename a group

`PUT /prompt-groups/:id/favorite` – mark group as favorite
