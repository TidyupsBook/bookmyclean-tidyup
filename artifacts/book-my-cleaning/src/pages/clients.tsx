import { useMemo, useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListClients,
  ClientRecord,
  getListClientsQueryKey,
  useCreateClient,
  useUpdateClient,
} from "@workspace/api-client-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Users,
  Search,
  Phone,
  Mail,
  MapPin,
  AlertCircle,
  Link2,
  Plus,
  Edit2,
} from "lucide-react";
import {
  CustomerTagChip,
  CustomerTagPicker,
} from "@/components/CustomerTagControls";

/**
 * The client directory: one card per customer, deduplicated across bookings,
 * Jobber imports, Jobber quotes and converted leads. The whole list arrives
 * in one response and search filters it locally — a cleaning company's
 * client list is hundreds, not millions, and instant-as-you-type beats a
 * round trip per keystroke.
 */

function clientAddress(c: ClientRecord): string | null {
  const line = [c.streetAddress, c.city, c.province].filter(Boolean).join(", ");
  const full = [line, c.postalCode].filter(Boolean).join(" ").trim();
  return full || null;
}

/** Digits-only, so "(403) 555-0117" matches a search for "4035550117". */
function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function matchesSearch(c: ClientRecord, needle: string): boolean {
  const text = needle.trim().toLowerCase();
  if (!text) return true;
  const inText = [c.name, c.email, clientAddress(c)]
    .filter(Boolean)
    .some((v) => v!.toLowerCase().includes(text));
  if (inText) return true;
  const needleDigits = digits(text);
  if (!needleDigits) return false;
  return (
    digits(c.phone).includes(needleDigits) ||
    digits(c.phoneE164).includes(needleDigits)
  );
}

const SOURCE_LABEL: Record<string, string> = {
  booking: "From a booking",
  jobber: "From Jobber",
  lead: "From a lead",
  manual: "Added here",
};

const clientFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  phone: z.string().optional(),
  email: z.string().email("Invalid email").or(z.literal("")).optional(),
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  postalCode: z.string().optional(),
});

type ClientFormValues = z.infer<typeof clientFormSchema>;

function ClientEditorModal({
  client,
  open,
  onOpenChange,
}: {
  client?: ClientRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEditing = !!client;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<ClientFormValues>({
    resolver: zodResolver(clientFormSchema),
    defaultValues: {
      name: client?.name || "",
      phone: client?.phone || "",
      email: client?.email || "",
      streetAddress: client?.streetAddress || "",
      city: client?.city || "",
      province: client?.province || "",
      postalCode: client?.postalCode || "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: client?.name || "",
        phone: client?.phone || "",
        email: client?.email || "",
        streetAddress: client?.streetAddress || "",
        city: client?.city || "",
        province: client?.province || "",
        postalCode: client?.postalCode || "",
      });
    }
  }, [client, open, form]);

  const createClient = useCreateClient();
  const updateClient = useUpdateClient();

  const onSubmit = (data: ClientFormValues) => {
    const payload = {
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      streetAddress: data.streetAddress || null,
      city: data.city || null,
      province: data.province || null,
      postalCode: data.postalCode || null,
    };

    if (isEditing) {
      updateClient.mutate(
        { id: client.id, data: payload },
        {
          onSuccess: (updated) => {
            queryClient.setQueryData(
              getListClientsQueryKey(),
              (old: ClientRecord[] | undefined) =>
                old
                  ? old.map((c) => (c.id === updated.id ? updated : c))
                  : [updated],
            );
            toast({ title: "Client updated" });
            onOpenChange(false);
          },
          onError: () =>
            toast({
              title: "Failed to update client",
              variant: "destructive",
            }),
        },
      );
    } else {
      createClient.mutate(
        { data: payload },
        {
          onSuccess: (created) => {
            queryClient.setQueryData(
              getListClientsQueryKey(),
              (old: ClientRecord[] | undefined) =>
                old ? [created, ...old] : [created],
            );
            toast({ title: "Client created" });
            onOpenChange(false);
          },
          onError: () =>
            toast({
              title: "Failed to create client",
              variant: "destructive",
            }),
        },
      );
    }
  };

  const isPending = createClient.isPending || updateClient.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Client" : "New Client"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="John Doe" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input placeholder="(555) 123-4567" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="john@example.com"
                        type="email"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="streetAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Street Address</FormLabel>
                  <FormControl>
                    <Input placeholder="123 Main St" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input placeholder="City" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="province"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>State / Prov</FormLabel>
                    <FormControl>
                      <Input placeholder="NY" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>ZIP</FormLabel>
                    <FormControl>
                      <Input placeholder="10001" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving..." : "Save Client"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function ClientsPage() {
  const { data: clients, isLoading, isError } = useListClients();
  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get("search") ?? "",
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientRecord | null>(null);

  const visible = useMemo(
    () => (clients ?? []).filter((c) => matchesSearch(c, search)),
    [clients, search],
  );

  return (
    <AppLayout>
      <PageHeader
        title="Clients"
        description={
          clients?.length
            ? `${clients.length} ${clients.length === 1 ? "client" : "clients"} on file, gathered from bookings, Jobber and leads.`
            : "Every customer you've booked, quoted or imported, in one place."
        }
      >
        <Button
          onClick={() => setIsCreateOpen(true)}
          className="gap-2"
          data-testid="button-new-client"
        >
          <Plus className="h-4 w-4" />
          New Client
        </Button>
      </PageHeader>

      <div className="relative mb-6 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, phone, email or address..."
          className="pl-9"
          aria-label="Search clients"
        />
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <AlertCircle className="h-4 w-4 shrink-0" />
          We couldn't load your clients. Refresh to try again.
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border rounded-lg">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          {search.trim() ? (
            <p className="text-sm text-muted-foreground">
              No clients match "{search.trim()}".
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">
                No clients yet
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Clients appear here as you take bookings — and come over from
                Jobber when it syncs.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((c) => {
            const address = clientAddress(c);
            return (
              <div
                key={c.id}
                className="border border-border rounded-lg bg-card p-4 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center flex-wrap gap-2">
                    <p className="font-medium text-foreground leading-tight">
                      {c.name}
                    </p>
                    {c.jobberClientId && (
                      <Badge
                        variant="outline"
                        className="text-emerald-300 border-emerald-500/20 bg-emerald-500/10 shrink-0"
                      >
                        <Link2 className="h-3 w-3 mr-1" />
                        Jobber
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground shrink-0 -mt-1 -mr-2"
                    onClick={() => setEditingClient(c)}
                    data-testid={`button-edit-client-${c.id}`}
                    aria-label={`Edit ${c.name}`}
                  >
                    <Edit2 className="h-4 w-4" />
                  </Button>
                </div>
                <CustomerTagChip
                  tag={c.tag}
                  testid={`chip-tag-client-${c.id}`}
                />
                <div className="space-y-1.5 text-sm text-muted-foreground mt-1">
                  {c.phone && (
                    <p className="flex items-center gap-2">
                      <Phone className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                      <a
                        href={`tel:${c.phoneE164 ?? c.phone}`}
                        className="hover:underline"
                      >
                        {c.phone}
                      </a>
                    </p>
                  )}
                  {c.email && (
                    <p className="flex items-center gap-2 min-w-0">
                      <Mail className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                      <a
                        href={`mailto:${c.email}`}
                        className="hover:underline truncate"
                      >
                        {c.email}
                      </a>
                    </p>
                  )}
                  {address && (
                    <p className="flex items-start gap-2">
                      <MapPin className="h-3.5 w-3.5 text-gray-400 shrink-0 mt-0.5" />
                      <span>{address}</span>
                    </p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-auto pt-1">
                  {SOURCE_LABEL[c.source] ?? c.source}
                </p>
                <CustomerTagPicker
                  kind="client"
                  id={c.id}
                  value={c.tag}
                  testidPrefix={`button-tag-client-${c.id}`}
                />
              </div>
            );
          })}
        </div>
      )}

      <ClientEditorModal
        client={editingClient}
        open={!!editingClient || isCreateOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateOpen(false);
            setEditingClient(null);
          }
        }}
      />
    </AppLayout>
  );
}
