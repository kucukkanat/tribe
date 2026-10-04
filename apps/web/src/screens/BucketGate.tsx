import type { ComponentChildren } from "preact";
import type { Bucket } from "../lib/core";
import { Empty, Skeleton } from "../components/ui";

export function BucketGate({ bucket, error, children }: { bucket: Bucket | null; error: string | null; children: ComponentChildren }) {
  if (error) return (
    <div class="panel"><Empty title="This bucket couldn't be opened" action={<a class="btn" href="#/buckets">Back to buckets</a>}>{error}</Empty></div>
  );
  if (!bucket) return <><div class="skeleton sk-line" style={{ width: "40%", height: 28, marginBottom: 20 }} /><Skeleton /></>;
  if (bucket.myRole() === null) return (
    <div class="panel"><Empty title="Waiting for approval" action={<a class="btn" href="#/buckets">Back to buckets</a>}>An admin needs to approve your request before you can read this bucket.</Empty></div>
  );
  return <>{children}</>;
}
