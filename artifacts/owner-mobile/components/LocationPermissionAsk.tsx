/**
 * The one-time "should this phone show on the map?" ask.
 *
 * Sharing used to be a switch buried on the Location tab: a cleaner had to be
 * told it existed before they'd ever find it, and the owner's own handsets
 * were no different. This asks on the first signed-in launch instead — in our
 * own words first, so the single system dialog isn't spent on someone who
 * doesn't yet know why we want it — and then never asks that person on this
 * phone again, whichever way they answered.
 *
 * Saying no is one tap and is remembered. The Location tab keeps the switch
 * for anyone who changes their mind.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import colors from "@/constants/colors";
import { useLocationTracking } from "@/lib/location-tracking";
import {
  hasAskedForLocation,
  markAskedForLocation,
  shouldOfferLocationAtSignIn,
} from "@/lib/this-device";

const c = colors.light;

export function LocationPermissionAsk() {
  const { isSignedIn, userId } = useAuth();
  // "unsupported" is the tracker's own word for a build that cannot report a
  // position (the web build). Taking it from there rather than re-checking
  // Platform keeps one answer to "can this device be on the map at all".
  const { enabled, permissionGranted, canAskAgain, enable, status } =
    useLocationTracking();

  const who = userId ?? "";

  // The answer is stamped with whose answer it is. A phone that changes hands
  // must not show B the sheet on A's "no", nor silence it on A's "yes", in
  // the render before the new storage read lands — so an answer belonging to
  // anyone but the current user counts as "don't know yet".
  const [answer, setAnswer] = useState<{ who: string; asked: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const askedBefore = answer && answer.who === who ? answer.asked : null;

  // Who is signed in *now*, readable from inside an await without capturing a
  // stale closure.
  const currentWho = useRef(who);
  useEffect(() => {
    currentWho.current = who;
  }, [who]);

  useEffect(() => {
    if (!isSignedIn || !who) {
      setAnswer(null);
      return;
    }
    let cancelled = false;
    void hasAskedForLocation(who).then((asked) => {
      if (!cancelled) setAnswer({ who, asked });
    });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, who]);

  const remember = useCallback(
    async (asWho: string) => {
      // Flip the local answer first so the sheet closes immediately, even if
      // the write is slow or the phone refuses storage.
      setAnswer({ who: asWho, asked: true });
      await markAskedForLocation(asWho);
    },
    [setAnswer],
  );

  const visible = shouldOfferLocationAtSignIn({
    supported: status !== "unsupported",
    signedIn: !!isSignedIn,
    enabled,
    permissionGranted,
    canAskAgain,
    askedBefore,
  });

  const onTurnOn = useCallback(() => {
    const asWho = who;
    setBusy(true);
    void (async () => {
      // Recorded before the system dialog: a prompt swiped away still counts
      // as having been asked.
      await remember(asWho);
      // If the phone signed out or changed hands during that write, stop
      // here: turning on tracking is consent, and it belongs to the person
      // who tapped, not to whoever is holding the phone now.
      if (currentWho.current !== asWho) {
        setBusy(false);
        return;
      }
      try {
        await enable();
      } finally {
        if (currentWho.current === asWho) setBusy(false);
      }
    })();
  }, [enable, remember, who]);

  const onNotNow = useCallback(() => {
    void remember(who);
  }, [remember, who]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onNotNow}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.iconRing}>
            <Feather name="map-pin" size={20} color={c.primary} />
          </View>
          <Text style={styles.title}>Show this phone on the map?</Text>
          <Text style={styles.body}>
            Your location puts a live pin on the crew map while you&rsquo;re
            working, so the office can see who is nearest a job. We only ask
            once — you can change it any time on the Location tab.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onTurnOn}
            disabled={busy}
            style={[styles.primaryButton, busy && styles.buttonBusy]}
          >
            <Text style={styles.primaryLabel}>
              {busy ? "Turning on…" : "Turn it on"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onNotNow}
            disabled={busy}
            style={styles.ghostButton}
          >
            <Text style={styles.ghostLabel}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: c.card,
    borderRadius: colors.radius + 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    padding: 22,
    gap: 12,
  },
  iconRing: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.secondary,
  },
  title: {
    color: c.foreground,
    fontSize: 19,
    fontWeight: "700",
  },
  body: {
    color: c.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
  },
  primaryButton: {
    marginTop: 6,
    backgroundColor: c.primary,
    borderRadius: colors.radius,
    paddingVertical: 13,
    alignItems: "center",
  },
  buttonBusy: {
    opacity: 0.6,
  },
  primaryLabel: {
    color: c.primaryForeground,
    fontSize: 15,
    fontWeight: "700",
  },
  ghostButton: {
    paddingVertical: 11,
    alignItems: "center",
  },
  ghostLabel: {
    color: c.mutedForeground,
    fontSize: 15,
    fontWeight: "600",
  },
});
