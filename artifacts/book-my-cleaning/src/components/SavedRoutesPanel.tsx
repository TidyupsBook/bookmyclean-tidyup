import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSavedRoutes,
  useCreateSavedRoute,
  useUpdateSavedRoute,
  useDeleteSavedRoute,
  useGetSavedRoute,
  useReorderSavedRouteStops,
  useDeleteSavedRouteStop,
  getListSavedRoutesQueryKey,
  getGetSavedRouteQueryKey,
  type SavedRoute,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  MapPin,
  Navigation,
  Plus,
  Trash2,
  GripVertical,
  CalendarPlus,
  X,
  Edit2,
  Check,
} from "lucide-react";
import { Link } from "wouter";
import {
  routePlanTotalKm,
  routePlanLegs,
  moveRouteStop,
} from "@/lib/mapRoutePlan";
import { formatDriveMinutes } from "@/lib/nearest";
import { useToast } from "@/hooks/use-toast";
import { type MapData } from "@workspace/api-client-react";

export function SavedRoutesPanel({
  activeRouteId,
  onSelectRoute,
  teamMembers,
  mapData,
  routeAddMode,
  onToggleRouteAddMode,
}: {
  activeRouteId: number | null;
  onSelectRoute: (id: number | null) => void;
  teamMembers: Array<{ id: number; name: string }>;
  mapData: MapData | undefined;
  routeAddMode: boolean;
  onToggleRouteAddMode: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: routes = [] } = useListSavedRoutes();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTeamMemberId, setNewTeamMemberId] = useState<number | "">("");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const createRoute = useCreateSavedRoute();
  const deleteRoute = useDeleteSavedRoute();

  const handleCreate = () => {
    if (!newName.trim() || newTeamMemberId === "") return;
    createRoute.mutate(
      { data: { name: newName.trim(), teamMemberId: Number(newTeamMemberId) } },
      {
        onSuccess: (route) => {
          setCreating(false);
          setNewName("");
          setNewTeamMemberId("");
          queryClient.invalidateQueries({
            queryKey: getListSavedRoutesQueryKey(),
          });
          onSelectRoute(route.id);
          toast({ title: "Route created" });
        },
        onError: () =>
          toast({ title: "Could not create route", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteRoute.mutate(
      { id },
      {
        onSuccess: () => {
          if (activeRouteId === id) onSelectRoute(null);
          queryClient.invalidateQueries({
            queryKey: getListSavedRoutesQueryKey(),
          });
          setDeletingId(null);
          toast({ title: "Route deleted" });
        },
        onError: (err: any) => {
          toast({
            title: "Could not delete route",
            description: err.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border/50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Navigation className="w-4 h-4 text-muted-foreground" />
          Saved routes
        </h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCreating(!creating)}
          className="h-6 w-6"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {creating && (
        <div className="p-3 bg-secondary/30 space-y-2 border-b border-border/50">
          <Input
            placeholder="Route name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-8 text-sm"
          />
          <select
            value={newTeamMemberId}
            onChange={(e) => setNewTeamMemberId(Number(e.target.value))}
            className="w-full h-8 text-sm rounded-md border border-input bg-transparent px-3 py-1 shadow-sm"
          >
            <option value="" disabled>
              Select cleaner...
            </option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={
                !newName.trim() ||
                newTeamMemberId === "" ||
                createRoute.isPending
              }
              onClick={handleCreate}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {deletingId !== null && (
        <AlertDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setDeletingId(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete route?</AlertDialogTitle>
              <AlertDialogDescription>
                This route and its stops will be removed. Scheduled bookings
                remain on the calendar.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-700"
                onClick={() => handleDelete(deletingId)}
              >
                Delete route
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <div className="max-h-[300px] overflow-y-auto p-2 space-y-2">
        {routes.length === 0 && !creating && (
          <p className="text-xs text-muted-foreground p-2">
            No saved routes yet.
          </p>
        )}
        {routes.map((r) => (
          <div
            key={r.id}
            className={`rounded-lg border transition-colors ${activeRouteId === r.id ? "border-brand-purple bg-brand-purple/5" : "border-transparent hover:bg-secondary/50"}`}
          >
            <div
              className="p-3 flex items-center justify-between cursor-pointer"
              onClick={() =>
                onSelectRoute(activeRouteId === r.id ? null : r.id)
              }
            >
              <div>
                <div className="font-medium text-sm text-foreground flex items-center gap-1">
                  {r.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {teamMembers.find((m) => m.id === r.teamMemberId)?.name ||
                    "Unassigned"}{" "}
                  · {r.stops?.length ?? 0} stops
                </div>
              </div>
              <div className="flex items-center gap-1">
                {activeRouteId === r.id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingId(r.id);
                    }}
                    title="Delete route"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
            {activeRouteId === r.id && (
              <ActiveRouteDetails
                routeId={r.id}
                teamMembers={teamMembers}
                mapData={mapData}
                routeAddMode={routeAddMode}
                onToggleRouteAddMode={onToggleRouteAddMode}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ActiveRouteDetails({
  routeId,
  teamMembers,
  mapData,
  routeAddMode,
  onToggleRouteAddMode,
}: {
  routeId: number;
  teamMembers: Array<{ id: number; name: string }>;
  mapData: MapData | undefined;
  routeAddMode: boolean;
  onToggleRouteAddMode: () => void;
}) {
  const { data: route } = useGetSavedRoute(routeId);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteStop = useDeleteSavedRouteStop();
  const reorderStops = useReorderSavedRouteStops();
  const updateRoute = useUpdateSavedRoute();

  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");

  const [deletingStopId, setDeletingStopId] = useState<number | null>(null);

  if (!route)
    return (
      <div className="p-3 text-xs text-muted-foreground text-center">
        Loading...
      </div>
    );

  const handleRemoveStop = (stopId: number) => {
    deleteStop.mutate(
      { routeId, stopId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetSavedRouteQueryKey(routeId),
          });
          queryClient.invalidateQueries({
            queryKey: getListSavedRoutesQueryKey(),
          });
          setDeletingStopId(null);
        },
        onError: (err: any) => {
          toast({
            title: "Could not remove stop",
            description: err.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleMoveStop = (stopId: number, direction: -1 | 1) => {
    const stops = route.stops.map((s) => ({ id: s.id, position: s.position }));
    const newOrder = moveRouteStop(stops, stopId, direction);
    reorderStops.mutate(
      { id: routeId, data: { stopIds: newOrder } },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({
            queryKey: getGetSavedRouteQueryKey(routeId),
          }),
        onError: (err: any) => {
          toast({
            title: "Could not reorder stops",
            description: err.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleUpdateName = () => {
    if (!editNameValue.trim() || editNameValue === route.name) {
      setEditingName(false);
      return;
    }
    updateRoute.mutate(
      { id: routeId, data: { name: editNameValue.trim() } },
      {
        onSuccess: () => {
          setEditingName(false);
          queryClient.invalidateQueries({
            queryKey: getGetSavedRouteQueryKey(routeId),
          });
          queryClient.invalidateQueries({
            queryKey: getListSavedRoutesQueryKey(),
          });
        },
      },
    );
  };

  const handleReassign = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (!val) return;
    updateRoute.mutate(
      { id: routeId, data: { teamMemberId: Number(val) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetSavedRouteQueryKey(routeId),
          });
          queryClient.invalidateQueries({
            queryKey: getListSavedRoutesQueryKey(),
          });
          toast({ title: "Route reassigned" });
        },
        onError: (err: any) => {
          toast({
            title: "Could not reassign route",
            description: err.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const sortedStops = [...(route.stops || [])].sort(
    (a, b) => a.position - b.position || a.id - b.id,
  );

  let totalKm = 0;
  let computedLegs: any[] = [];
  if (sortedStops.length > 0) {
    let startPoint: any = null;
    const cleaner = mapData?.cleaners?.find(
      (c) => c.teamMemberId === route.teamMemberId,
    );
    if (cleaner) {
      startPoint = { lat: cleaner.lat, lng: cleaner.lng, label: cleaner.name };
    } else {
      const home = mapData?.staffHomes?.find(
        (h) => h.teamMemberId === route.teamMemberId,
      );
      if (home) startPoint = { lat: home.lat, lng: home.lng, label: home.name };
    }
    if (startPoint) {
      computedLegs = routePlanLegs(
        startPoint,
        sortedStops.map((s) => ({ ...s, label: s.name })),
      );
      totalKm = routePlanTotalKm(computedLegs);
    }
  }

  return (
    <div className="px-3 pb-3 pt-1 border-t border-brand-purple/20">
      <div className="flex items-center justify-between mb-3 mt-1">
        {editingName ? (
          <div className="flex items-center gap-1 w-full">
            <Input
              value={editNameValue}
              onChange={(e) => setEditNameValue(e.target.value)}
              className="h-6 text-xs px-2 w-full"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleUpdateName()}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={handleUpdateName}
            >
              <Check className="w-3.5 h-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between text-xs text-muted-foreground w-full">
            <div className="flex items-center gap-1 group">
              <span
                className="font-medium text-foreground truncate max-w-[150px]"
                title={route.name}
              >
                {route.name}
              </span>
              <Button
                variant="ghost"
                size="icon"
                data-testid="edit-route-name"
                className="h-5 w-5 opacity-0 group-hover:opacity-100"
                aria-label="Rename route"
                onClick={() => {
                  setEditNameValue(route.name);
                  setEditingName(true);
                }}
              >
                <Edit2 className="w-3 h-3" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="mb-2">
        <label className="text-[10px] uppercase font-bold text-muted-foreground block mb-1">
          Assignee
        </label>
        <select
          value={route.teamMemberId ?? ""}
          onChange={handleReassign}
          className="w-full text-xs bg-transparent border border-border rounded px-2 py-1 focus:ring-1 focus:ring-brand-purple focus:outline-none"
          aria-label="Reassign route"
        >
          <option value="" disabled>
            Select cleaner...
          </option>
          {teamMembers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-2">
        <Button
          variant={routeAddMode ? "default" : "outline"}
          size="sm"
          className="w-full text-xs h-7"
          onClick={onToggleRouteAddMode}
        >
          {routeAddMode ? (
            <X className="w-3 h-3 mr-1" />
          ) : (
            <MapPin className="w-3 h-3 mr-1" />
          )}
          {routeAddMode ? "Cancel adding from map" : "Add stop from map"}
        </Button>
      </div>

      <div className="space-y-1">
        {sortedStops.map((stop, i) => (
          <div
            key={stop.id}
            className="flex items-center gap-2 p-2 bg-background rounded-md border border-border/50 shadow-sm text-xs"
          >
            <div className="flex flex-col gap-0.5">
              <button
                disabled={i === 0}
                onClick={() => handleMoveStop(stop.id, -1)}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
              <button
                disabled={i === sortedStops.length - 1}
                onClick={() => handleMoveStop(stop.id, 1)}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>

            <div className="flex-1 min-w-0">
              <div className="font-medium truncate flex items-center gap-1">
                <span className="inline-flex items-center justify-center bg-brand-purple text-white rounded-[4px] w-[14px] h-[14px] text-[9px] font-bold">
                  {i + 1}
                </span>
                <span className="truncate">{stop.name}</span>
              </div>
              {stop.address && (
                <div className="text-[10px] text-muted-foreground truncate">
                  {stop.address}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {stop.linkedBookingId ? (
                <Link
                  href={`/bookings#booking-${stop.linkedBookingId}`}
                  className="text-brand-purple hover:text-brand-purple/80 p-1 flex items-center gap-1 bg-brand-purple/10 rounded"
                  title="View booking"
                >
                  <Check className="w-3 h-3" />
                  <span className="text-[10px] font-medium">Booked</span>
                </Link>
              ) : (
                <Link
                  href={`/bookings/new?routeId=${routeId}&routeStopId=${stop.id}&assign=${route.teamMemberId}`}
                  className="text-brand-purple hover:text-brand-purple/80 p-1 bg-brand-purple/10 rounded"
                  title="Add to schedule"
                >
                  <CalendarPlus className="w-3.5 h-3.5" />
                </Link>
              )}
              <button
                onClick={() => setDeletingStopId(stop.id)}
                className="p-1 text-muted-foreground hover:text-red-500 rounded hover:bg-secondary"
                aria-label={`Remove stop ${stop.name}`}
                title={`Remove stop ${stop.name}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}

        {deletingStopId !== null && (
          <AlertDialog
            open={true}
            onOpenChange={(open) => {
              if (!open) setDeletingStopId(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove stop?</AlertDialogTitle>
                <AlertDialogDescription>
                  This stop will be removed from the route.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 hover:bg-red-700"
                  onClick={() => handleRemoveStop(deletingStopId)}
                >
                  Remove stop
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {sortedStops.length === 0 && (
          <div className="text-center p-4 text-muted-foreground border border-dashed border-border rounded-md">
            Click "Add stop" on pins, or use the route planning tool on the map.
          </div>
        )}
      </div>
      {computedLegs.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-[10px] uppercase font-bold text-muted-foreground mb-2">
            Straight-line estimates
          </div>
          <div className="space-y-1 mb-2">
            {computedLegs.map((leg, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between text-xs text-muted-foreground"
              >
                <span className="truncate pr-2">To {leg.to.name}</span>
                <span className="shrink-0 font-mono">{leg.distance}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="font-semibold text-foreground">Total</span>
            <div className="text-right">
              <span className="font-semibold text-foreground">
                {totalKm.toFixed(1)} km
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {formatDriveMinutes(totalKm)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
