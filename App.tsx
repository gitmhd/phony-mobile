import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  Text,
  TouchableOpacity,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  View,
  StatusBar,
} from 'react-native';
import BackgroundService from 'react-native-background-actions';
import Geolocation from 'react-native-geolocation-service';
import { createClient } from '@supabase/supabase-js';

// -------------------------------------------------------------
// 1. SUPABASE CLIENT INITIALIZATION
// Replace with your exact credentials from Phase 1
// -------------------------------------------------------------
const SUPABASE_URL = 'https://nvgmqbuswzkmnhcrpyti.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52Z21xYnVzd3prbW5oY3JweXRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NDg5NDUsImV4cCI6MjEwNTUyNDk0NX0.h64PbG7LttbzQwuisF8c6b1NqRIYGYyIL-k-npiJWmA';
const DEVICE_ID = 'phony-device';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Query current GPS fix via Promise
const getDevicePosition = (): Promise<Geolocation.GeoPosition> => {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      pos => resolve(pos),
      err => reject(err),
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 5000,
        forceRequestLocation: true,
      },
    );
  });
};

// -------------------------------------------------------------
// 2. FOREGROUND TASK EXECUTOR (Runs in persistent background thread)
// -------------------------------------------------------------
const backgroundPhonyBeacon = async () => {
  console.log('[Phony] Background Service started. Subscribing to Supabase...');

  const channel = supabase
    .channel('phony_device_listener')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'ping_requests',
      },
      async payload => {
        const row = payload.new;
        console.log('[Phony] Inbound row detected:', row);

        if (row.device_id === DEVICE_ID && row.status === 'pending') {
          console.log('[Phony] Processing ping request ID:', row.id);

          try {
            const position = await getDevicePosition();
            console.log('[Phony] GPS Lock acquired:', position.coords);

            // Update row to complete status with precise coordinates
            const { error: updateError } = await supabase
              .from('ping_requests')
              .update({
                status: 'completed',
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
                completed_at: new Date().toISOString(),
              })
              .eq('id', row.id);

            if (updateError) {
              console.error('[Phony] Update failed:', updateError.message);
            } else {
              console.log('[Phony] Database successfully updated.');
            }
          } catch (locationErr: any) {
            console.error('[Phony] Error acquiring GPS fix:', locationErr);
            await supabase
              .from('ping_requests')
              .update({ status: 'failed' })
              .eq('id', row.id);
          }
        }
      },
    )
    .subscribe(status => {
      console.log('[Phony] Supabase Realtime channel status:', status);
    });

  // Keep the background task alive
  while (BackgroundService.isRunning()) {
    await sleep(5000);
  }

  console.log('[Phony] Unsubscribing channel and shutting down...');
  supabase.removeChannel(channel);
};

// -------------------------------------------------------------
// 3. MAIN UI COMPONENT
// -------------------------------------------------------------
export default function App() {
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    setIsRunning(BackgroundService.isRunning());
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      // 1. Core location permissions
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ]);

      // 2. Notification permission (Android 13+)
      if (Platform.Version >= 33) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      }

      // 3. Background location permission (Android 10+)
      if (Platform.Version >= 29) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
        );
      }
    }
  };

  const startBeacon = async () => {
    await requestPermissions();

    const options = {
      taskName: 'PhonyBeacon',
      taskTitle: 'Phony Beacon Active',
      taskDesc: 'Listening for remote dashboard location pings...',
      taskIcon: {
        name: 'ic_launcher',
        type: 'mipmap',
      },
      color: '#2563eb',
      linkingURI: 'phony://',
      parameters: { delay: 5000 },
    };

    try {
      await BackgroundService.start(backgroundPhonyBeacon, options);
      setIsRunning(true);
    } catch (e) {
      console.error('[Phony] Service start error:', e);
    }
  };

  const stopBeacon = async () => {
    try {
      await BackgroundService.stop();
      setIsRunning(false);
    } catch (e) {
      console.error('[Phony] Service stop error:', e);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#020617" />
      <View style={styles.card}>
        <Text style={styles.appName}>PHONY</Text>
        <Text style={styles.deviceIdLabel}>
          Device ID: <Text style={styles.deviceIdValue}>{DEVICE_ID}</Text>
        </Text>

        <View style={styles.statusBox}>
          <View
            style={[
              styles.statusIndicator,
              { backgroundColor: isRunning ? '#22c55e' : '#ef4444' },
            ]}
          />
          <Text style={styles.statusText}>
            {isRunning ? 'Service Running (Listening)' : 'Service Idle'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.btn, isRunning ? styles.btnStop : styles.btnStart]}
          onPress={isRunning ? stopBeacon : startBeacon}
          activeOpacity={0.8}
        >
          <Text style={styles.btnText}>
            {isRunning ? 'Deactivate Beacon' : 'Activate Beacon'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#020617',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: '88%',
    backgroundColor: '#0f172a',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e293b',
    elevation: 4,
  },
  appName: {
    fontSize: 26,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: 2,
  },
  deviceIdLabel: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 4,
    marginBottom: 20,
  },
  deviceIdValue: {
    color: '#38bdf8',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    fontWeight: '600',
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 28,
    backgroundColor: '#1e293b',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 9999,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '500',
  },
  btn: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnStart: {
    backgroundColor: '#2563eb',
  },
  btnStop: {
    backgroundColor: '#dc2626',
  },
  btnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
