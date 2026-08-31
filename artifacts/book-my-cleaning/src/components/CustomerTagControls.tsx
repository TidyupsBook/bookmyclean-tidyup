import { useEffect, useState } from "react";
import {
  useUpdateCustomerTag,
  type CustomerTagResultKind,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { TagChip, TagPicker, type QuickTag } from "@/components/TagControls";

export function CustomerTagPicker({
  kind,
  id,
  value,
  testidPrefix,
}: {
  kind: CustomerTagResultKind;
  id: number;
  value: string | null | undefined;
  testidPrefix: string;
}) {
  const update = useUpdateCustomerTag();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tag, setTag] = useState<string | null | undefined>(value);

  useEffect(() => setTag(value), [value]);

  return (
    <div
      // CustomerTagPicker is also rendered inside clickable list rows. Keep
      // both pointer clicks and keyboard activation inside the verdict
      // controls instead of opening the row's detail view.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <TagPicker
        value={tag}
        disabled={update.isPending}
        testidPrefix={testidPrefix}
        onSelect={(next: QuickTag | null) => {
          update.mutate(
            { kind, id, data: { tag: next } },
            {
              onSuccess: (result) => {
                setTag(result.tag);
                queryClient.invalidateQueries();
              },
              onError: () =>
                toast({
                  title: "Couldn't save that tag",
                  description: "Try again in a moment.",
                  variant: "destructive",
                }),
            },
          );
        }}
      />
    </div>
  );
}

export function CustomerTagChip({
  tag,
  testid,
}: {
  tag: string | null | undefined;
  testid?: string;
}) {
  return <TagChip tag={tag} testid={testid} />;
}
