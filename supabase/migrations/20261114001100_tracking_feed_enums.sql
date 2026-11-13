-- Adventures Phase C, the tracking feed (D189): booking history records a
-- rider's Start Ride and Finish Ride and a staff correction of the ride
-- window. Its own migration: a new enum value cannot be used in the
-- transaction that adds it.

alter type public.adventure_booking_event_kind add value 'ride_started';
alter type public.adventure_booking_event_kind add value 'ride_finished';
alter type public.adventure_booking_event_kind add value 'capture_corrected';
