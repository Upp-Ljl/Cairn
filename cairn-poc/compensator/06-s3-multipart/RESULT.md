# POC 06 — S3 Multipart Upload (P5)

## Result: 3/3 cases PASS (with caveats)

| Case | Forward state | Revert action | Verified |
|------|---------------|---------------|----------|
| A — new key | COMPLETED | DELETE object | 404 after revert |
| B — crash mid-upload after part 2 | UPLOADING_PARTS | AbortMultipartUpload | no in-progress uploads remain |
| C — overwrite existing (versioned bucket) | COMPLETED, existedBefore | PUT previous version metadata | matches before-image |

## Partial-revert state machine

```
     initiate        uploadPart          completeMPU
  +-------------+  +--------------+   +---------------+
  | INIT_PENDING|->| INITIATED    |->| UPLOADING_PARTS|
  +-------------+  +--------------+   +-------+-------+
                                              |
                        +-------- partN succeeds (N<lastN)
                        |                     |
                        v                     v
                  still UPLOADING_PARTS   COMPLETED
                                              |
                                   +----------+----------+
                                   |                     |
                           existedBefore=false    existedBefore=true
                                   |                     |
                                   v                     v
                           DELETE object         PUT previous version
                                                 (requires versioned
                                                 bucket; else lost)
```

## Latency

- `recordMs` (HEAD-like GET check for existence): 9-10 ms.
- Actual upload is dominated by PUT-Part bandwidth, not by the record step.

## Key finding

**The lane file is persisted incrementally after each state transition** (INIT_PENDING -> INITIATED -> UPLOADING_PARTS -> COMPLETED). This matters because S3 multipart is a distributed-state operation: if the agent process dies, a sweeper can read the lane file, see state=UPLOADING_PARTS + uploadId, and abort the orphaned upload. Without incremental persistence the partial state would be unreachable.

## Gaps

- **Non-versioned bucket + overwrite of existing = unrecoverable.** Revert can only put back metadata; byte content is gone. Our mock fakes this by storing metadata only; with real S3 the bytes are replaced and the previous version is GC'd.
- Multi-part copy (`UploadPartCopy`) not modeled.
- If revert is run between `UploadPart` and `CompleteMultipartUpload` on a lane we did not create, we cannot know whether the orphan came from us — S3 list-uploads is the only source of truth, and the `x-cairn-lane-id` metadata would need to be stashed at Initiate time (real S3 supports user metadata on multipart).
