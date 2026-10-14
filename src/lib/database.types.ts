export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      appointment_events: {
        Row: {
          actor_staff_id: string | null;
          actor_user_id: string | null;
          appointment_id: string;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["appointment_event_type"];
          from_status: Database["public"]["Enums"]["appointment_status"] | null;
          id: number;
          payload: NonNullable<Json>;
          reason: string | null;
          to_status: Database["public"]["Enums"]["appointment_status"] | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          actor_user_id?: string | null;
          appointment_id: string;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["appointment_event_type"];
          from_status?: Database["public"]["Enums"]["appointment_status"] | null;
          id?: never;
          payload?: NonNullable<Json>;
          reason?: string | null;
          to_status?: Database["public"]["Enums"]["appointment_status"] | null;
        };
        Update: {
          actor_staff_id?: string | null;
          actor_user_id?: string | null;
          appointment_id?: string;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["appointment_event_type"];
          from_status?: Database["public"]["Enums"]["appointment_status"] | null;
          id?: never;
          payload?: NonNullable<Json>;
          reason?: string | null;
          to_status?: Database["public"]["Enums"]["appointment_status"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "appointment_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_events_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
        ];
      };
      appointment_types: {
        Row: {
          active: boolean;
          capacity_units: number;
          created_at: string;
          description: string | null;
          duration_minutes: number;
          id: string;
          name: string;
          public: boolean;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          capacity_units?: number;
          created_at?: string;
          description?: string | null;
          duration_minutes: number;
          id?: string;
          name: string;
          public?: boolean;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          capacity_units?: number;
          created_at?: string;
          description?: string | null;
          duration_minutes?: number;
          id?: string;
          name?: string;
          public?: boolean;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      appointments: {
        Row: {
          appointment_type_id: string;
          arrived_at: string | null;
          bike_id: string | null;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_via: Database["public"]["Enums"]["appointment_source"] | null;
          capacity_units: number;
          checked_in_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          created_by_staff_id: string | null;
          created_by_user_id: string | null;
          customer_id: string;
          customer_note: string | null;
          ends_at: string;
          id: string;
          internal_note: string | null;
          no_show_at: string | null;
          source: Database["public"]["Enums"]["appointment_source"];
          starts_at: string;
          status: Database["public"]["Enums"]["appointment_status"];
          updated_at: string;
        };
        Insert: {
          appointment_type_id: string;
          arrived_at?: string | null;
          bike_id?: string | null;
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_via?: Database["public"]["Enums"]["appointment_source"] | null;
          capacity_units: number;
          checked_in_at?: string | null;
          completed_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          created_by_staff_id?: string | null;
          created_by_user_id?: string | null;
          customer_id: string;
          customer_note?: string | null;
          ends_at: string;
          id?: string;
          internal_note?: string | null;
          no_show_at?: string | null;
          source: Database["public"]["Enums"]["appointment_source"];
          starts_at: string;
          status?: Database["public"]["Enums"]["appointment_status"];
          updated_at?: string;
        };
        Update: {
          appointment_type_id?: string;
          arrived_at?: string | null;
          bike_id?: string | null;
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_via?: Database["public"]["Enums"]["appointment_source"] | null;
          capacity_units?: number;
          checked_in_at?: string | null;
          completed_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          created_by_staff_id?: string | null;
          created_by_user_id?: string | null;
          customer_id?: string;
          customer_note?: string | null;
          ends_at?: string;
          id?: string;
          internal_note?: string | null;
          no_show_at?: string | null;
          source?: Database["public"]["Enums"]["appointment_source"];
          starts_at?: string;
          status?: Database["public"]["Enums"]["appointment_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointments_appointment_type_id_fkey";
            columns: ["appointment_type_id"];
            isOneToOne: false;
            referencedRelation: "appointment_types";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_bike_id_fkey";
            columns: ["bike_id"];
            isOneToOne: false;
            referencedRelation: "bikes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_created_by_staff_id_fkey";
            columns: ["created_by_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
        ];
      };
      attachment_events: {
        Row: {
          actor_staff_id: string | null;
          attachment_id: string;
          correlation_id: string | null;
          created_at: string;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          event_type: Database["public"]["Enums"]["attachment_event_type"];
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          attachment_id: string;
          correlation_id?: string | null;
          created_at?: string;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          event_type: Database["public"]["Enums"]["attachment_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
        };
        Update: {
          actor_staff_id?: string | null;
          attachment_id?: string;
          correlation_id?: string | null;
          created_at?: string;
          entity_id?: string;
          entity_type?: Database["public"]["Enums"]["attachment_entity"];
          event_type?: Database["public"]["Enums"]["attachment_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "attachment_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      attachments: {
        Row: {
          byte_size: number | null;
          caption: string | null;
          created_at: string;
          created_by: string | null;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          height: number | null;
          id: string;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          updated_at: string;
          visibility: Database["public"]["Enums"]["attachment_visibility"];
          width: number | null;
        };
        Insert: {
          byte_size?: number | null;
          caption?: string | null;
          created_at?: string;
          created_by?: string | null;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          height?: number | null;
          id?: string;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          updated_at?: string;
          visibility?: Database["public"]["Enums"]["attachment_visibility"];
          width?: number | null;
        };
        Update: {
          byte_size?: number | null;
          caption?: string | null;
          created_at?: string;
          created_by?: string | null;
          entity_id?: string;
          entity_type?: Database["public"]["Enums"]["attachment_entity"];
          height?: number | null;
          id?: string;
          media_type?: string;
          storage_bucket?: string;
          storage_path?: string;
          updated_at?: string;
          visibility?: Database["public"]["Enums"]["attachment_visibility"];
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "attachments_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      bike_ownership_events: {
        Row: {
          actor_staff_id: string | null;
          bike_id: string;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["bike_ownership_event_type"];
          from_customer_id: string | null;
          id: string;
          reason: string | null;
          to_customer_id: string | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          bike_id: string;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["bike_ownership_event_type"];
          from_customer_id?: string | null;
          id?: string;
          reason?: string | null;
          to_customer_id?: string | null;
        };
        Update: {
          actor_staff_id?: string | null;
          bike_id?: string;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["bike_ownership_event_type"];
          from_customer_id?: string | null;
          id?: string;
          reason?: string | null;
          to_customer_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "bike_ownership_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bike_ownership_events_bike_id_fkey";
            columns: ["bike_id"];
            isOneToOne: false;
            referencedRelation: "bikes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bike_ownership_events_from_customer_id_fkey";
            columns: ["from_customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bike_ownership_events_to_customer_id_fkey";
            columns: ["to_customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
        ];
      };
      bikes: {
        Row: {
          archived_at: string | null;
          brand: string;
          colour: string | null;
          created_at: string;
          customer_id: string | null;
          description: string | null;
          frame_size: string | null;
          id: string;
          internal_notes: string | null;
          inventory_unit_id: string | null;
          model: string;
          search_text: string | null;
          serial_key: string | null;
          serial_number: string | null;
          short_id: string;
          updated_at: string;
          variant: string | null;
        };
        Insert: {
          archived_at?: string | null;
          brand: string;
          colour?: string | null;
          created_at?: string;
          customer_id?: string | null;
          description?: string | null;
          frame_size?: string | null;
          id?: string;
          internal_notes?: string | null;
          inventory_unit_id?: string | null;
          model: string;
          search_text?: never;
          serial_key?: never;
          serial_number?: string | null;
          short_id?: string;
          updated_at?: string;
          variant?: string | null;
        };
        Update: {
          archived_at?: string | null;
          brand?: string;
          colour?: string | null;
          created_at?: string;
          customer_id?: string | null;
          description?: string | null;
          frame_size?: string | null;
          id?: string;
          internal_notes?: string | null;
          inventory_unit_id?: string | null;
          model?: string;
          search_text?: never;
          serial_key?: never;
          serial_number?: string | null;
          short_id?: string;
          updated_at?: string;
          variant?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "bikes_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bikes_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "bikes_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
        ];
      };
      categories: {
        Row: {
          archived_at: string | null;
          created_at: string;
          id: string;
          kind: Database["public"]["Enums"]["category_kind"];
          name: string;
          parent_id: string | null;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          id?: string;
          kind: Database["public"]["Enums"]["category_kind"];
          name: string;
          parent_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["category_kind"];
          name?: string;
          parent_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["id"];
          },
        ];
      };
      closure_overrides: {
        Row: {
          closes_at: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          id: string;
          kind: Database["public"]["Enums"]["closure_kind"];
          opens_at: string | null;
          reason: string;
          starts_at: string;
          updated_at: string;
        };
        Insert: {
          closes_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at: string;
          id?: string;
          kind: Database["public"]["Enums"]["closure_kind"];
          opens_at?: string | null;
          reason: string;
          starts_at: string;
          updated_at?: string;
        };
        Update: {
          closes_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["closure_kind"];
          opens_at?: string | null;
          reason?: string;
          starts_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "closure_overrides_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      consignment_item_charges: {
        Row: {
          amount: number;
          bearer: Database["public"]["Enums"]["charge_bearer"];
          consignment_item_id: string;
          created_at: string;
          created_by: string | null;
          currency: string;
          description: string;
          id: string;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
          work_order_id: string | null;
        };
        Insert: {
          amount: number;
          bearer: Database["public"]["Enums"]["charge_bearer"];
          consignment_item_id: string;
          created_at?: string;
          created_by?: string | null;
          currency: string;
          description: string;
          id: string;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
          work_order_id?: string | null;
        };
        Update: {
          amount?: number;
          bearer?: Database["public"]["Enums"]["charge_bearer"];
          consignment_item_id?: string;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          description?: string;
          id?: string;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
          work_order_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "consignment_item_charges_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_item_charges_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_item_charges_voided_by_fkey";
            columns: ["voided_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_item_charges_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "consignment_item_charges_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "consignment_item_charges_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      consignment_item_events: {
        Row: {
          actor_staff_id: string | null;
          consignment_item_id: string;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["consignment_item_event_type"];
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          consignment_item_id: string;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["consignment_item_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
        };
        Update: {
          actor_staff_id?: string | null;
          consignment_item_id?: string;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["consignment_item_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "consignment_item_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_item_events_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
        ];
      };
      consignment_items: {
        Row: {
          agreed_amount_owed: number;
          agreement_notes: string | null;
          asking_price: number | null;
          consignor_id: string;
          created_at: string;
          created_by: string | null;
          currency: string;
          id: string;
          internal_notes: string | null;
          inventory_unit_id: string | null;
          product_id: string;
          quantity: number;
          received_at: string;
          request_fingerprint: string | null;
          return_reason: string | null;
          returned_at: string | null;
          short_id: string;
          sold_at: string | null;
          status: Database["public"]["Enums"]["consignment_status"];
          updated_at: string;
        };
        Insert: {
          agreed_amount_owed: number;
          agreement_notes?: string | null;
          asking_price?: number | null;
          consignor_id: string;
          created_at?: string;
          created_by?: string | null;
          currency: string;
          id: string;
          internal_notes?: string | null;
          inventory_unit_id?: string | null;
          product_id: string;
          quantity?: number;
          received_at?: string;
          request_fingerprint?: string | null;
          return_reason?: string | null;
          returned_at?: string | null;
          short_id?: string;
          sold_at?: string | null;
          status?: Database["public"]["Enums"]["consignment_status"];
          updated_at?: string;
        };
        Update: {
          agreed_amount_owed?: number;
          agreement_notes?: string | null;
          asking_price?: number | null;
          consignor_id?: string;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          id?: string;
          internal_notes?: string | null;
          inventory_unit_id?: string | null;
          product_id?: string;
          quantity?: number;
          received_at?: string;
          request_fingerprint?: string | null;
          return_reason?: string | null;
          returned_at?: string | null;
          short_id?: string;
          sold_at?: string | null;
          status?: Database["public"]["Enums"]["consignment_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "consignment_items_consignor_id_fkey";
            columns: ["consignor_id"];
            isOneToOne: false;
            referencedRelation: "consignors";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_items_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_items_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: true;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "consignment_items_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: true;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "consignment_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
        ];
      };
      consignment_settlement_reversals: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          reason: string;
          settlement_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id: string;
          reason: string;
          settlement_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          reason?: string;
          settlement_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "consignment_settlement_reversals_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_settlement_reversals_settlement_id_fkey";
            columns: ["settlement_id"];
            isOneToOne: true;
            referencedRelation: "consignment_settlements";
            referencedColumns: ["id"];
          },
        ];
      };
      consignment_settlements: {
        Row: {
          amount: number;
          consignor_id: string;
          created_at: string;
          created_by: string | null;
          currency: string;
          id: string;
          notes: string | null;
          paid_at: string;
          reference: string | null;
          request_fingerprint: string | null;
        };
        Insert: {
          amount: number;
          consignor_id: string;
          created_at?: string;
          created_by?: string | null;
          currency: string;
          id: string;
          notes?: string | null;
          paid_at: string;
          reference?: string | null;
          request_fingerprint?: string | null;
        };
        Update: {
          amount?: number;
          consignor_id?: string;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          id?: string;
          notes?: string | null;
          paid_at?: string;
          reference?: string | null;
          request_fingerprint?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "consignment_settlements_consignor_id_fkey";
            columns: ["consignor_id"];
            isOneToOne: false;
            referencedRelation: "consignors";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignment_settlements_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      consignors: {
        Row: {
          archived_at: string | null;
          created_at: string;
          created_by: string | null;
          customer_id: string | null;
          display_name: string;
          email: string | null;
          id: string;
          internal_notes: string | null;
          payout_details: string | null;
          phone: string | null;
          phone_digits: string | null;
          search_text: string | null;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string | null;
          display_name: string;
          email?: string | null;
          id?: string;
          internal_notes?: string | null;
          payout_details?: string | null;
          phone?: string | null;
          phone_digits?: never;
          search_text?: never;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string | null;
          display_name?: string;
          email?: string | null;
          id?: string;
          internal_notes?: string | null;
          payout_details?: string | null;
          phone?: string | null;
          phone_digits?: never;
          search_text?: never;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "consignors_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consignors_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
        ];
      };
      cult_commons_rates: {
        Row: {
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          effective_from: string;
          id: string;
          rate: number;
        };
        Insert: {
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          effective_from: string;
          id?: string;
          rate: number;
        };
        Update: {
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          id?: string;
          rate?: number;
        };
        Relationships: [
          {
            foreignKeyName: "cult_commons_rates_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cult_commons_rates_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      customers: {
        Row: {
          archived_at: string | null;
          auth_user_id: string | null;
          created_at: string;
          display_name: string | null;
          email: string | null;
          first_name: string | null;
          id: string;
          internal_notes: string | null;
          last_name: string | null;
          phone: string | null;
          phone_digits: string | null;
          search_text: string | null;
          shopify_customer_id: string | null;
          short_id: string | null;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          auth_user_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          first_name?: string | null;
          id?: string;
          internal_notes?: string | null;
          last_name?: string | null;
          phone?: string | null;
          phone_digits?: never;
          search_text?: never;
          shopify_customer_id?: string | null;
          short_id?: string | null;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          auth_user_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          first_name?: string | null;
          id?: string;
          internal_notes?: string | null;
          last_name?: string | null;
          phone?: string | null;
          phone_digits?: never;
          search_text?: never;
          shopify_customer_id?: string | null;
          short_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      integration_audit_events: {
        Row: {
          actor_staff_id: string | null;
          correlation_id: string | null;
          created_at: string;
          customer_id: string | null;
          event_type: Database["public"]["Enums"]["integration_audit_type"];
          id: string;
          integration_event_id: string | null;
          job_id: string | null;
          payload: NonNullable<Json>;
          product_id: string | null;
          reason: string | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          customer_id?: string | null;
          event_type: Database["public"]["Enums"]["integration_audit_type"];
          id?: string;
          integration_event_id?: string | null;
          job_id?: string | null;
          payload?: NonNullable<Json>;
          product_id?: string | null;
          reason?: string | null;
        };
        Update: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          customer_id?: string | null;
          event_type?: Database["public"]["Enums"]["integration_audit_type"];
          id?: string;
          integration_event_id?: string | null;
          job_id?: string | null;
          payload?: NonNullable<Json>;
          product_id?: string | null;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "integration_audit_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_audit_events_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_audit_events_integration_event_id_fkey";
            columns: ["integration_event_id"];
            isOneToOne: false;
            referencedRelation: "integration_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_audit_events_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "integration_retry_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_audit_events_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "integration_audit_events_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_events: {
        Row: {
          api_version: string | null;
          attempts: number;
          body_bytes: number;
          body_sha256: string;
          correlation_id: string | null;
          created_at: string;
          delivery_count: number;
          external_event_id: string;
          headers: NonNullable<Json>;
          hmac_valid: boolean;
          id: string;
          last_delivered_at: string;
          last_error: string | null;
          last_error_code: string | null;
          last_error_detail: string | null;
          outcome: string | null;
          payload: Json | null;
          payload_purged_at: string | null;
          processed_at: string | null;
          provider: string;
          received_at: string;
          rejection_reason: Database["public"]["Enums"]["integration_rejection_reason"] | null;
          result: NonNullable<Json>;
          sale_id: string | null;
          shop_domain: string | null;
          shopify_event_id: string | null;
          shopify_order_gid: string | null;
          status: Database["public"]["Enums"]["integration_event_status"];
          subject: string | null;
          test_delivery: boolean;
          topic: string;
          triggered_at: string | null;
          updated_at: string;
        };
        Insert: {
          api_version?: string | null;
          attempts?: number;
          body_bytes: number;
          body_sha256: string;
          correlation_id?: string | null;
          created_at?: string;
          delivery_count?: number;
          external_event_id: string;
          headers?: NonNullable<Json>;
          hmac_valid: boolean;
          id?: string;
          last_delivered_at?: string;
          last_error?: string | null;
          last_error_code?: string | null;
          last_error_detail?: string | null;
          outcome?: string | null;
          payload?: Json | null;
          payload_purged_at?: string | null;
          processed_at?: string | null;
          provider?: string;
          received_at?: string;
          rejection_reason?: Database["public"]["Enums"]["integration_rejection_reason"] | null;
          result?: NonNullable<Json>;
          sale_id?: string | null;
          shop_domain?: string | null;
          shopify_event_id?: string | null;
          shopify_order_gid?: string | null;
          status?: Database["public"]["Enums"]["integration_event_status"];
          subject?: string | null;
          test_delivery?: boolean;
          topic: string;
          triggered_at?: string | null;
          updated_at?: string;
        };
        Update: {
          api_version?: string | null;
          attempts?: number;
          body_bytes?: number;
          body_sha256?: string;
          correlation_id?: string | null;
          created_at?: string;
          delivery_count?: number;
          external_event_id?: string;
          headers?: NonNullable<Json>;
          hmac_valid?: boolean;
          id?: string;
          last_delivered_at?: string;
          last_error?: string | null;
          last_error_code?: string | null;
          last_error_detail?: string | null;
          outcome?: string | null;
          payload?: Json | null;
          payload_purged_at?: string | null;
          processed_at?: string | null;
          provider?: string;
          received_at?: string;
          rejection_reason?: Database["public"]["Enums"]["integration_rejection_reason"] | null;
          result?: NonNullable<Json>;
          sale_id?: string | null;
          shop_domain?: string | null;
          shopify_event_id?: string | null;
          shopify_order_gid?: string | null;
          status?: Database["public"]["Enums"]["integration_event_status"];
          subject?: string | null;
          test_delivery?: boolean;
          topic?: string;
          triggered_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "sales";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_retry_queue: {
        Row: {
          attempts: number;
          created_at: string;
          id: string;
          integration_event_id: string | null;
          kind: Database["public"]["Enums"]["integration_job_kind"];
          last_error: string | null;
          last_error_code: string | null;
          last_retried_at: string | null;
          last_retried_by: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          product_id: string | null;
          resolution_reason: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: Database["public"]["Enums"]["integration_job_status"];
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          id?: string;
          integration_event_id?: string | null;
          kind: Database["public"]["Enums"]["integration_job_kind"];
          last_error?: string | null;
          last_error_code?: string | null;
          last_retried_at?: string | null;
          last_retried_by?: string | null;
          locked_at?: string | null;
          max_attempts?: number;
          next_attempt_at?: string;
          product_id?: string | null;
          resolution_reason?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: Database["public"]["Enums"]["integration_job_status"];
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          id?: string;
          integration_event_id?: string | null;
          kind?: Database["public"]["Enums"]["integration_job_kind"];
          last_error?: string | null;
          last_error_code?: string | null;
          last_retried_at?: string | null;
          last_retried_by?: string | null;
          locked_at?: string | null;
          max_attempts?: number;
          next_attempt_at?: string;
          product_id?: string | null;
          resolution_reason?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: Database["public"]["Enums"]["integration_job_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_retry_queue_integration_event_id_fkey";
            columns: ["integration_event_id"];
            isOneToOne: false;
            referencedRelation: "integration_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_retry_queue_last_retried_by_fkey";
            columns: ["last_retried_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_retry_queue_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "integration_retry_queue_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_retry_queue_resolved_by_fkey";
            columns: ["resolved_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      inventory_movements: {
        Row: {
          consignment_item_id: string | null;
          correlation_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          id: number;
          inventory_unit_id: string | null;
          location_id: string;
          movement_type: Database["public"]["Enums"]["movement_type"];
          product_id: string;
          purchase_receipt_line_id: string | null;
          quantity_delta: number;
          reason: string | null;
          request_id: string | null;
          reversal_of_id: number | null;
          sale_line_id: string | null;
          unit_cost_snapshot: number | null;
          work_order_id: string | null;
          work_order_line_item_id: string | null;
        };
        Insert: {
          consignment_item_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          id?: never;
          inventory_unit_id?: string | null;
          location_id: string;
          movement_type: Database["public"]["Enums"]["movement_type"];
          product_id: string;
          purchase_receipt_line_id?: string | null;
          quantity_delta: number;
          reason?: string | null;
          request_id?: string | null;
          reversal_of_id?: number | null;
          sale_line_id?: string | null;
          unit_cost_snapshot?: number | null;
          work_order_id?: string | null;
          work_order_line_item_id?: string | null;
        };
        Update: {
          consignment_item_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          id?: never;
          inventory_unit_id?: string | null;
          location_id?: string;
          movement_type?: Database["public"]["Enums"]["movement_type"];
          product_id?: string;
          purchase_receipt_line_id?: string | null;
          quantity_delta?: number;
          reason?: string | null;
          request_id?: string | null;
          reversal_of_id?: number | null;
          sale_line_id?: string | null;
          unit_cost_snapshot?: number | null;
          work_order_id?: string | null;
          work_order_line_item_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "inventory_movements_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "inventory_movements_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "inventory_movements_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_purchase_receipt_line_id_fkey";
            columns: ["purchase_receipt_line_id"];
            isOneToOne: false;
            referencedRelation: "purchase_receipt_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_purchase_receipt_line_id_fkey";
            columns: ["purchase_receipt_line_id"];
            isOneToOne: false;
            referencedRelation: "purchase_receipt_lines_staff";
            referencedColumns: ["purchase_receipt_line_id"];
          },
          {
            foreignKeyName: "inventory_movements_reversal_of_id_fkey";
            columns: ["reversal_of_id"];
            isOneToOne: true;
            referencedRelation: "inventory_movement_costs";
            referencedColumns: ["movement_id"];
          },
          {
            foreignKeyName: "inventory_movements_reversal_of_id_fkey";
            columns: ["reversal_of_id"];
            isOneToOne: true;
            referencedRelation: "inventory_movements";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_sale_line_id_fkey";
            columns: ["sale_line_id"];
            isOneToOne: false;
            referencedRelation: "sale_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "inventory_movements_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "inventory_movements_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_work_order_line_item_id_fkey";
            columns: ["work_order_line_item_id"];
            isOneToOne: false;
            referencedRelation: "work_order_line_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_movements_work_order_line_item_id_fkey";
            columns: ["work_order_line_item_id"];
            isOneToOne: false;
            referencedRelation: "work_order_line_items_staff";
            referencedColumns: ["id"];
          },
        ];
      };
      inventory_unit_events: {
        Row: {
          actor_staff_id: string | null;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["inventory_unit_event_type"];
          id: string;
          payload: NonNullable<Json>;
          reason: string | null;
          unit_id: string;
        };
        Insert: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["inventory_unit_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
          unit_id: string;
        };
        Update: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["inventory_unit_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          reason?: string | null;
          unit_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "inventory_unit_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_unit_events_unit_id_fkey";
            columns: ["unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "inventory_unit_events_unit_id_fkey";
            columns: ["unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
        ];
      };
      inventory_units: {
        Row: {
          archived_at: string | null;
          bike_id: string | null;
          condition: string | null;
          consignment_item_id: string | null;
          created_at: string;
          created_by: string | null;
          direct_cost: number | null;
          id: string;
          internal_notes: string | null;
          location_id: string;
          ownership_type: Database["public"]["Enums"]["ownership_type"];
          product_id: string;
          sale_price: number | null;
          serial_key: string | null;
          serial_number: string | null;
          short_id: string;
          sold_at: string | null;
          sold_sale_line_id: string | null;
          status: Database["public"]["Enums"]["unit_status"];
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          bike_id?: string | null;
          condition?: string | null;
          consignment_item_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          direct_cost?: number | null;
          id?: string;
          internal_notes?: string | null;
          location_id: string;
          ownership_type?: Database["public"]["Enums"]["ownership_type"];
          product_id: string;
          sale_price?: number | null;
          serial_key?: never;
          serial_number?: string | null;
          short_id?: string;
          sold_at?: string | null;
          sold_sale_line_id?: string | null;
          status?: Database["public"]["Enums"]["unit_status"];
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          bike_id?: string | null;
          condition?: string | null;
          consignment_item_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          direct_cost?: number | null;
          id?: string;
          internal_notes?: string | null;
          location_id?: string;
          ownership_type?: Database["public"]["Enums"]["ownership_type"];
          product_id?: string;
          sale_price?: number | null;
          serial_key?: never;
          serial_number?: string | null;
          short_id?: string;
          sold_at?: string | null;
          sold_sale_line_id?: string | null;
          status?: Database["public"]["Enums"]["unit_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "inventory_units_bike_id_fkey";
            columns: ["bike_id"];
            isOneToOne: true;
            referencedRelation: "bikes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_units_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_units_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_units_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_units_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "inventory_units_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_units_sold_sale_line_id_fkey";
            columns: ["sold_sale_line_id"];
            isOneToOne: true;
            referencedRelation: "sale_lines";
            referencedColumns: ["id"];
          },
        ];
      };
      job_part_requests: {
        Row: {
          cancel_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          decided_at: string | null;
          description: string;
          expected_unit_cost: number | null;
          fitted_at: string | null;
          fitted_by: string | null;
          id: string;
          kind: Database["public"]["Enums"]["part_request_kind"];
          line_total: number | null;
          ordered_at: string | null;
          ordered_by: string | null;
          product_id: string | null;
          purchase_order_line_id: string | null;
          quantity: number;
          service_id: string | null;
          status: Database["public"]["Enums"]["part_request_status"];
          supplier_id: string | null;
          unit_sale_price: number;
          updated_at: string;
          work_order_id: string;
          work_order_line_item_id: string | null;
        };
        Insert: {
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency: string;
          decided_at?: string | null;
          description: string;
          expected_unit_cost?: number | null;
          fitted_at?: string | null;
          fitted_by?: string | null;
          id: string;
          kind: Database["public"]["Enums"]["part_request_kind"];
          line_total?: never;
          ordered_at?: string | null;
          ordered_by?: string | null;
          product_id?: string | null;
          purchase_order_line_id?: string | null;
          quantity: number;
          service_id?: string | null;
          status?: Database["public"]["Enums"]["part_request_status"];
          supplier_id?: string | null;
          unit_sale_price: number;
          updated_at?: string;
          work_order_id: string;
          work_order_line_item_id?: string | null;
        };
        Update: {
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          decided_at?: string | null;
          description?: string;
          expected_unit_cost?: number | null;
          fitted_at?: string | null;
          fitted_by?: string | null;
          id?: string;
          kind?: Database["public"]["Enums"]["part_request_kind"];
          line_total?: never;
          ordered_at?: string | null;
          ordered_by?: string | null;
          product_id?: string | null;
          purchase_order_line_id?: string | null;
          quantity?: number;
          service_id?: string | null;
          status?: Database["public"]["Enums"]["part_request_status"];
          supplier_id?: string | null;
          unit_sale_price?: number;
          updated_at?: string;
          work_order_id?: string;
          work_order_line_item_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_part_requests_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_fitted_by_fkey";
            columns: ["fitted_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_ordered_by_fkey";
            columns: ["ordered_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "job_part_requests_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_purchase_order_line_id_fkey";
            columns: ["purchase_order_line_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_purchase_order_line_id_fkey";
            columns: ["purchase_order_line_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_lines_staff";
            referencedColumns: ["purchase_order_line_id"];
          },
          {
            foreignKeyName: "job_part_requests_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services_staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "suppliers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_line_item_id_fkey";
            columns: ["work_order_line_item_id"];
            isOneToOne: false;
            referencedRelation: "work_order_line_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_line_item_id_fkey";
            columns: ["work_order_line_item_id"];
            isOneToOne: false;
            referencedRelation: "work_order_line_items_staff";
            referencedColumns: ["id"];
          },
        ];
      };
      label_templates: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          height_mm: number;
          id: string;
          is_default: boolean;
          kind: Database["public"]["Enums"]["label_kind"];
          layout: NonNullable<Json>;
          name: string;
          updated_at: string;
          width_mm: number;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          height_mm: number;
          id?: string;
          is_default?: boolean;
          kind: Database["public"]["Enums"]["label_kind"];
          layout: NonNullable<Json>;
          name: string;
          updated_at?: string;
          width_mm: number;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          height_mm?: number;
          id?: string;
          is_default?: boolean;
          kind?: Database["public"]["Enums"]["label_kind"];
          layout?: NonNullable<Json>;
          name?: string;
          updated_at?: string;
          width_mm?: number;
        };
        Relationships: [
          {
            foreignKeyName: "label_templates_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      locations: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          kind: Database["public"]["Enums"]["location_kind"];
          name: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["location_kind"];
          name: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["location_kind"];
          name?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      payment_refunds: {
        Row: {
          amount: number;
          created_at: string;
          currency: string;
          failure_reason: string | null;
          id: string;
          last_event_id: string;
          livemode: boolean | null;
          payment_id: string | null;
          reason: string | null;
          status: Database["public"]["Enums"]["stripe_refund_status"];
          stripe_created_at: string | null;
          stripe_payment_intent_id: string;
          stripe_refund_id: string;
          updated_at: string;
        };
        Insert: {
          amount: number;
          created_at?: string;
          currency: string;
          failure_reason?: string | null;
          id?: string;
          last_event_id: string;
          livemode?: boolean | null;
          payment_id?: string | null;
          reason?: string | null;
          status: Database["public"]["Enums"]["stripe_refund_status"];
          stripe_created_at?: string | null;
          stripe_payment_intent_id: string;
          stripe_refund_id: string;
          updated_at?: string;
        };
        Update: {
          amount?: number;
          created_at?: string;
          currency?: string;
          failure_reason?: string | null;
          id?: string;
          last_event_id?: string;
          livemode?: boolean | null;
          payment_id?: string | null;
          reason?: string | null;
          status?: Database["public"]["Enums"]["stripe_refund_status"];
          stripe_created_at?: string | null;
          stripe_payment_intent_id?: string;
          stripe_refund_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "payment_refunds_last_event_id_fkey";
            columns: ["last_event_id"];
            isOneToOne: false;
            referencedRelation: "stripe_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payment_refunds_payment_id_fkey";
            columns: ["payment_id"];
            isOneToOne: false;
            referencedRelation: "payments";
            referencedColumns: ["id"];
          },
        ];
      };
      payments: {
        Row: {
          amount: number;
          amount_cents: number | null;
          amount_received: number | null;
          checked_at: string | null;
          checkout_completed_at: string | null;
          created_at: string;
          currency: string;
          expired_at: string | null;
          failed_at: string | null;
          id: string;
          kind: Database["public"]["Enums"]["payment_kind"];
          last_event_id: string | null;
          livemode: boolean;
          paid_at: string | null;
          quote_id: string | null;
          refunded_amount: number;
          status: Database["public"]["Enums"]["payment_status"];
          stripe_checkout_session_id: string;
          stripe_payment_intent_id: string | null;
          stripe_session_expires_at: string;
          updated_at: string;
          work_order_id: string;
        };
        Insert: {
          amount: number;
          amount_cents?: never;
          amount_received?: number | null;
          checked_at?: string | null;
          checkout_completed_at?: string | null;
          created_at?: string;
          currency?: string;
          expired_at?: string | null;
          failed_at?: string | null;
          id: string;
          kind: Database["public"]["Enums"]["payment_kind"];
          last_event_id?: string | null;
          livemode: boolean;
          paid_at?: string | null;
          quote_id?: string | null;
          refunded_amount?: number;
          status?: Database["public"]["Enums"]["payment_status"];
          stripe_checkout_session_id: string;
          stripe_payment_intent_id?: string | null;
          stripe_session_expires_at: string;
          updated_at?: string;
          work_order_id: string;
        };
        Update: {
          amount?: number;
          amount_cents?: never;
          amount_received?: number | null;
          checked_at?: string | null;
          checkout_completed_at?: string | null;
          created_at?: string;
          currency?: string;
          expired_at?: string | null;
          failed_at?: string | null;
          id?: string;
          kind?: Database["public"]["Enums"]["payment_kind"];
          last_event_id?: string | null;
          livemode?: boolean;
          paid_at?: string | null;
          quote_id?: string | null;
          refunded_amount?: number;
          status?: Database["public"]["Enums"]["payment_status"];
          stripe_checkout_session_id?: string;
          stripe_payment_intent_id?: string | null;
          stripe_session_expires_at?: string;
          updated_at?: string;
          work_order_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "payments_last_event_id_fkey";
            columns: ["last_event_id"];
            isOneToOne: false;
            referencedRelation: "stripe_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payments_quote_id_fkey";
            columns: ["quote_id"];
            isOneToOne: false;
            referencedRelation: "quotes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payments_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "payments_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "payments_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      print_jobs: {
        Row: {
          adapter: Database["public"]["Enums"]["printer_adapter"];
          bike_id: string | null;
          completed_at: string | null;
          content: NonNullable<Json>;
          correlation_id: string | null;
          created_at: string;
          error: string | null;
          id: string;
          inventory_unit_id: string | null;
          label_kind: Database["public"]["Enums"]["label_kind"];
          label_template_id: string;
          printer_profile_id: string;
          product_id: string | null;
          profile_snapshot: NonNullable<Json>;
          qr_payload: string;
          quantity: number;
          rendered_at: string | null;
          reprint_of_id: string | null;
          requested_by: string;
          short_id: string;
          status: Database["public"]["Enums"]["print_status"];
          status_changed_by: string | null;
          template_snapshot: NonNullable<Json>;
          updated_at: string;
        };
        Insert: {
          adapter: Database["public"]["Enums"]["printer_adapter"];
          bike_id?: string | null;
          completed_at?: string | null;
          content: NonNullable<Json>;
          correlation_id?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          inventory_unit_id?: string | null;
          label_kind: Database["public"]["Enums"]["label_kind"];
          label_template_id: string;
          printer_profile_id: string;
          product_id?: string | null;
          profile_snapshot: NonNullable<Json>;
          qr_payload: string;
          quantity: number;
          rendered_at?: string | null;
          reprint_of_id?: string | null;
          requested_by: string;
          short_id: string;
          status?: Database["public"]["Enums"]["print_status"];
          status_changed_by?: string | null;
          template_snapshot: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          adapter?: Database["public"]["Enums"]["printer_adapter"];
          bike_id?: string | null;
          completed_at?: string | null;
          content?: NonNullable<Json>;
          correlation_id?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          inventory_unit_id?: string | null;
          label_kind?: Database["public"]["Enums"]["label_kind"];
          label_template_id?: string;
          printer_profile_id?: string;
          product_id?: string | null;
          profile_snapshot?: NonNullable<Json>;
          qr_payload?: string;
          quantity?: number;
          rendered_at?: string | null;
          reprint_of_id?: string | null;
          requested_by?: string;
          short_id?: string;
          status?: Database["public"]["Enums"]["print_status"];
          status_changed_by?: string | null;
          template_snapshot?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "print_jobs_bike_id_fkey";
            columns: ["bike_id"];
            isOneToOne: false;
            referencedRelation: "bikes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "print_jobs_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_label_template_id_fkey";
            columns: ["label_template_id"];
            isOneToOne: false;
            referencedRelation: "label_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_printer_profile_id_fkey";
            columns: ["printer_profile_id"];
            isOneToOne: false;
            referencedRelation: "printer_profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "print_jobs_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_reprint_of_id_fkey";
            columns: ["reprint_of_id"];
            isOneToOne: false;
            referencedRelation: "print_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_requested_by_fkey";
            columns: ["requested_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_status_changed_by_fkey";
            columns: ["status_changed_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      printer_profiles: {
        Row: {
          active: boolean;
          adapter: Database["public"]["Enums"]["printer_adapter"];
          config: NonNullable<Json>;
          created_at: string;
          created_by: string | null;
          id: string;
          is_default: boolean;
          name: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          adapter: Database["public"]["Enums"]["printer_adapter"];
          config?: NonNullable<Json>;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_default?: boolean;
          name: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          adapter?: Database["public"]["Enums"]["printer_adapter"];
          config?: NonNullable<Json>;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_default?: boolean;
          name?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "printer_profiles_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      product_events: {
        Row: {
          actor_staff_id: string | null;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["product_event_type"];
          id: string;
          payload: NonNullable<Json>;
          product_id: string;
          reason: string | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["product_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          product_id: string;
          reason?: string | null;
        };
        Update: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["product_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          product_id?: string;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "product_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "product_events_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "product_events_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
        ];
      };
      products: {
        Row: {
          active: boolean;
          archived_at: string | null;
          brand: string | null;
          category_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          default_direct_cost: number | null;
          default_sale_price: number | null;
          description: string | null;
          id: string;
          name: string;
          ownership_type: Database["public"]["Enums"]["ownership_type"];
          public_slug: string | null;
          publication_status: Database["public"]["Enums"]["publication_status"];
          reorder_point: number | null;
          search_text: string | null;
          shopify_product_id: string | null;
          shopify_variant_id: string | null;
          short_id: string;
          sku: string | null;
          sku_key: string | null;
          tracking_type: Database["public"]["Enums"]["tracking_type"];
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          archived_at?: string | null;
          brand?: string | null;
          category_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          default_direct_cost?: number | null;
          default_sale_price?: number | null;
          description?: string | null;
          id?: string;
          name: string;
          ownership_type?: Database["public"]["Enums"]["ownership_type"];
          public_slug?: string | null;
          publication_status?: Database["public"]["Enums"]["publication_status"];
          reorder_point?: number | null;
          search_text?: never;
          shopify_product_id?: string | null;
          shopify_variant_id?: string | null;
          short_id?: string;
          sku?: string | null;
          sku_key?: never;
          tracking_type: Database["public"]["Enums"]["tracking_type"];
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          archived_at?: string | null;
          brand?: string | null;
          category_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          default_direct_cost?: number | null;
          default_sale_price?: number | null;
          description?: string | null;
          id?: string;
          name?: string;
          ownership_type?: Database["public"]["Enums"]["ownership_type"];
          public_slug?: string | null;
          publication_status?: Database["public"]["Enums"]["publication_status"];
          reorder_point?: number | null;
          search_text?: never;
          shopify_product_id?: string | null;
          shopify_variant_id?: string | null;
          short_id?: string;
          sku?: string | null;
          sku_key?: never;
          tracking_type?: Database["public"]["Enums"]["tracking_type"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "products_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "products_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      purchase_order_events: {
        Row: {
          actor_staff_id: string | null;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["purchase_order_event_type"];
          id: string;
          payload: NonNullable<Json>;
          purchase_order_id: string;
          purchase_order_line_id: string | null;
          purchase_receipt_id: string | null;
          reason: string | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["purchase_order_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          purchase_order_id: string;
          purchase_order_line_id?: string | null;
          purchase_receipt_id?: string | null;
          reason?: string | null;
        };
        Update: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["purchase_order_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          purchase_order_id?: string;
          purchase_order_line_id?: string | null;
          purchase_receipt_id?: string | null;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_order_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_order_events_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_totals_staff";
            referencedColumns: ["purchase_order_id"];
          },
          {
            foreignKeyName: "purchase_order_events_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_order_events_purchase_receipt_id_fkey";
            columns: ["purchase_receipt_id"];
            isOneToOne: false;
            referencedRelation: "purchase_receipts";
            referencedColumns: ["id"];
          },
        ];
      };
      purchase_order_lines: {
        Row: {
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          ordered_total: number | null;
          product_id: string;
          purchase_order_id: string;
          quantity_ordered: number;
          unit_cost: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          currency: string;
          expected_at?: string | null;
          id?: string;
          notes?: string | null;
          ordered_total?: never;
          product_id: string;
          purchase_order_id: string;
          quantity_ordered: number;
          unit_cost: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          expected_at?: string | null;
          id?: string;
          notes?: string | null;
          ordered_total?: never;
          product_id?: string;
          purchase_order_id?: string;
          quantity_ordered?: number;
          unit_cost?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_order_lines_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_totals_staff";
            referencedColumns: ["purchase_order_id"];
          },
          {
            foreignKeyName: "purchase_order_lines_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      purchase_orders: {
        Row: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          po_number: string;
          received_at: string | null;
          status: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          supplier_id: string;
          supplier_reference: string | null;
          updated_at: string;
        };
        Insert: {
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency: string;
          expected_at?: string | null;
          id?: string;
          notes?: string | null;
          po_number?: string;
          received_at?: string | null;
          status?: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at?: string | null;
          submitted_by?: string | null;
          supplier_id: string;
          supplier_reference?: string | null;
          updated_at?: string;
        };
        Update: {
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          expected_at?: string | null;
          id?: string;
          notes?: string | null;
          po_number?: string;
          received_at?: string | null;
          status?: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at?: string | null;
          submitted_by?: string | null;
          supplier_id?: string;
          supplier_reference?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_orders_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_orders_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_orders_submitted_by_fkey";
            columns: ["submitted_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "suppliers";
            referencedColumns: ["id"];
          },
        ];
      };
      purchase_receipt_lines: {
        Row: {
          created_at: string;
          currency: string;
          id: string;
          line_number: number;
          location_id: string;
          product_id: string;
          purchase_order_line_id: string;
          purchase_receipt_id: string;
          quantity_received: number;
          received_total: number | null;
          unit_cost_actual: number;
        };
        Insert: {
          created_at?: string;
          currency: string;
          id?: string;
          line_number: number;
          location_id: string;
          product_id: string;
          purchase_order_line_id: string;
          purchase_receipt_id: string;
          quantity_received: number;
          received_total?: never;
          unit_cost_actual: number;
        };
        Update: {
          created_at?: string;
          currency?: string;
          id?: string;
          line_number?: number;
          location_id?: string;
          product_id?: string;
          purchase_order_line_id?: string;
          purchase_receipt_id?: string;
          quantity_received?: number;
          received_total?: never;
          unit_cost_actual?: number;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_receipt_lines_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_receipt_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "purchase_receipt_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_receipt_lines_purchase_order_line_id_fkey";
            columns: ["purchase_order_line_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_receipt_lines_purchase_order_line_id_fkey";
            columns: ["purchase_order_line_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_lines_staff";
            referencedColumns: ["purchase_order_line_id"];
          },
          {
            foreignKeyName: "purchase_receipt_lines_purchase_receipt_id_fkey";
            columns: ["purchase_receipt_id"];
            isOneToOne: false;
            referencedRelation: "purchase_receipts";
            referencedColumns: ["id"];
          },
        ];
      };
      purchase_receipts: {
        Row: {
          correlation_id: string | null;
          created_at: string;
          id: string;
          idempotency_key: string;
          notes: string | null;
          purchase_order_id: string;
          received_at: string;
          received_by: string;
          reference: string | null;
        };
        Insert: {
          correlation_id?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          notes?: string | null;
          purchase_order_id: string;
          received_at: string;
          received_by: string;
          reference?: string | null;
        };
        Update: {
          correlation_id?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          notes?: string | null;
          purchase_order_id?: string;
          received_at?: string;
          received_by?: string;
          reference?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_receipts_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_totals_staff";
            referencedColumns: ["purchase_order_id"];
          },
          {
            foreignKeyName: "purchase_receipts_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_receipts_received_by_fkey";
            columns: ["received_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      quote_items: {
        Row: {
          decision: string | null;
          description: string;
          id: string;
          kind: Database["public"]["Enums"]["part_request_kind"];
          line_total: number;
          part_request_id: string;
          position: number;
          quantity: number;
          quote_id: string;
          unit_sale_price: number;
        };
        Insert: {
          decision?: string | null;
          description: string;
          id?: string;
          kind: Database["public"]["Enums"]["part_request_kind"];
          line_total: number;
          part_request_id: string;
          position: number;
          quantity: number;
          quote_id: string;
          unit_sale_price: number;
        };
        Update: {
          decision?: string | null;
          description?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["part_request_kind"];
          line_total?: number;
          part_request_id?: string;
          position?: number;
          quantity?: number;
          quote_id?: string;
          unit_sale_price?: number;
        };
        Relationships: [
          {
            foreignKeyName: "quote_items_part_request_id_fkey";
            columns: ["part_request_id"];
            isOneToOne: false;
            referencedRelation: "job_part_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "quote_items_part_request_id_fkey";
            columns: ["part_request_id"];
            isOneToOne: false;
            referencedRelation: "job_part_requests_staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "quote_items_quote_id_fkey";
            columns: ["quote_id"];
            isOneToOne: false;
            referencedRelation: "quotes";
            referencedColumns: ["id"];
          },
        ];
      };
      quotes: {
        Row: {
          answered_at: string | null;
          answered_name: string | null;
          channel: Database["public"]["Enums"]["quote_channel"];
          currency: string;
          expires_at: string;
          id: string;
          sent_at: string;
          sent_by: string;
          status: Database["public"]["Enums"]["quote_status"];
          token_hash: string;
          total: number;
          withdrawn_at: string | null;
          withdrawn_by: string | null;
          work_order_id: string;
        };
        Insert: {
          answered_at?: string | null;
          answered_name?: string | null;
          channel: Database["public"]["Enums"]["quote_channel"];
          currency: string;
          expires_at: string;
          id: string;
          sent_at?: string;
          sent_by: string;
          status?: Database["public"]["Enums"]["quote_status"];
          token_hash: string;
          total: number;
          withdrawn_at?: string | null;
          withdrawn_by?: string | null;
          work_order_id: string;
        };
        Update: {
          answered_at?: string | null;
          answered_name?: string | null;
          channel?: Database["public"]["Enums"]["quote_channel"];
          currency?: string;
          expires_at?: string;
          id?: string;
          sent_at?: string;
          sent_by?: string;
          status?: Database["public"]["Enums"]["quote_status"];
          token_hash?: string;
          total?: number;
          withdrawn_at?: string | null;
          withdrawn_by?: string | null;
          work_order_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "quotes_sent_by_fkey";
            columns: ["sent_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "quotes_withdrawn_by_fkey";
            columns: ["withdrawn_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "quotes_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "quotes_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "quotes_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_lines: {
        Row: {
          consignment_item_id: string | null;
          consignor_payout_snapshot: number | null;
          cost_total: number | null;
          created_at: string;
          cult_commons_rate_snapshot: number;
          cult_commons_share: number | null;
          currency: string;
          description_snapshot: string;
          id: string;
          inventory_unit_id: string | null;
          line_number: number;
          product_id: string;
          quantity: number;
          restocked_at: string | null;
          restocked_by: string | null;
          sale_id: string;
          sale_total: number | null;
          shopify_line_item_id: string | null;
          shopify_line_part: number | null;
          unit_direct_cost_snapshot: number;
          unit_sale_price_snapshot: number;
          yield_total: number | null;
        };
        Insert: {
          consignment_item_id?: string | null;
          consignor_payout_snapshot?: number | null;
          cost_total?: never;
          created_at?: string;
          cult_commons_rate_snapshot: number;
          cult_commons_share?: never;
          currency: string;
          description_snapshot: string;
          id?: string;
          inventory_unit_id?: string | null;
          line_number: number;
          product_id: string;
          quantity: number;
          restocked_at?: string | null;
          restocked_by?: string | null;
          sale_id: string;
          sale_total?: never;
          shopify_line_item_id?: string | null;
          shopify_line_part?: number | null;
          unit_direct_cost_snapshot: number;
          unit_sale_price_snapshot: number;
          yield_total?: never;
        };
        Update: {
          consignment_item_id?: string | null;
          consignor_payout_snapshot?: number | null;
          cost_total?: never;
          created_at?: string;
          cult_commons_rate_snapshot?: number;
          cult_commons_share?: never;
          currency?: string;
          description_snapshot?: string;
          id?: string;
          inventory_unit_id?: string | null;
          line_number?: number;
          product_id?: string;
          quantity?: number;
          restocked_at?: string | null;
          restocked_by?: string | null;
          sale_id?: string;
          sale_total?: never;
          shopify_line_item_id?: string | null;
          shopify_line_part?: number | null;
          unit_direct_cost_snapshot?: number;
          unit_sale_price_snapshot?: number;
          yield_total?: never;
        };
        Relationships: [
          {
            foreignKeyName: "sale_lines_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_lines_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "sale_lines_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "sale_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_lines_restocked_by_fkey";
            columns: ["restocked_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_lines_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "sales";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_refunds: {
        Row: {
          amount: number;
          created_at: string;
          currency: string;
          id: string;
          integration_event_id: string | null;
          reason: string;
          recorded_by: string | null;
          restocked: boolean;
          sale_id: string;
          shopify_refund_id: string | null;
        };
        Insert: {
          amount: number;
          created_at?: string;
          currency: string;
          id: string;
          integration_event_id?: string | null;
          reason: string;
          recorded_by?: string | null;
          restocked?: boolean;
          sale_id: string;
          shopify_refund_id?: string | null;
        };
        Update: {
          amount?: number;
          created_at?: string;
          currency?: string;
          id?: string;
          integration_event_id?: string | null;
          reason?: string;
          recorded_by?: string | null;
          restocked?: boolean;
          sale_id?: string;
          shopify_refund_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sale_refunds_integration_event_id_fkey";
            columns: ["integration_event_id"];
            isOneToOne: false;
            referencedRelation: "integration_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_refunds_recorded_by_fkey";
            columns: ["recorded_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_refunds_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "sales";
            referencedColumns: ["id"];
          },
        ];
      };
      sales: {
        Row: {
          created_at: string;
          created_by: string | null;
          currency: string;
          customer_id: string | null;
          id: string;
          integration_event_id: string | null;
          notes: string | null;
          recognized_at: string;
          request_fingerprint: string | null;
          sale_number: string;
          shopify_customer_id: string | null;
          shopify_order_id: string | null;
          shopify_order_name: string | null;
          source: Database["public"]["Enums"]["sale_source"];
          status: Database["public"]["Enums"]["sale_status"];
          updated_at: string;
          work_order_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          currency: string;
          customer_id?: string | null;
          id: string;
          integration_event_id?: string | null;
          notes?: string | null;
          recognized_at: string;
          request_fingerprint?: string | null;
          sale_number?: string;
          shopify_customer_id?: string | null;
          shopify_order_id?: string | null;
          shopify_order_name?: string | null;
          source?: Database["public"]["Enums"]["sale_source"];
          status?: Database["public"]["Enums"]["sale_status"];
          updated_at?: string;
          work_order_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          customer_id?: string | null;
          id?: string;
          integration_event_id?: string | null;
          notes?: string | null;
          recognized_at?: string;
          request_fingerprint?: string | null;
          sale_number?: string;
          shopify_customer_id?: string | null;
          shopify_order_id?: string | null;
          shopify_order_name?: string | null;
          source?: Database["public"]["Enums"]["sale_source"];
          status?: Database["public"]["Enums"]["sale_status"];
          updated_at?: string;
          work_order_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sales_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_integration_event_id_fkey";
            columns: ["integration_event_id"];
            isOneToOne: false;
            referencedRelation: "integration_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "sales_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "sales_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      schedule_events: {
        Row: {
          actor_staff_id: string | null;
          actor_user_id: string | null;
          correlation_id: string | null;
          created_at: string;
          entity: Database["public"]["Enums"]["schedule_entity"];
          entity_id: string | null;
          event_type: Database["public"]["Enums"]["schedule_event_type"];
          id: number;
          payload: NonNullable<Json>;
          reason: string | null;
        };
        Insert: {
          actor_staff_id?: string | null;
          actor_user_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          entity: Database["public"]["Enums"]["schedule_entity"];
          entity_id?: string | null;
          event_type: Database["public"]["Enums"]["schedule_event_type"];
          id?: never;
          payload?: NonNullable<Json>;
          reason?: string | null;
        };
        Update: {
          actor_staff_id?: string | null;
          actor_user_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          entity?: Database["public"]["Enums"]["schedule_entity"];
          entity_id?: string | null;
          event_type?: Database["public"]["Enums"]["schedule_event_type"];
          id?: never;
          payload?: NonNullable<Json>;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "schedule_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      services: {
        Row: {
          active: boolean;
          archived_at: string | null;
          category_id: string | null;
          created_at: string;
          currency: string;
          default_direct_cost: number;
          default_sale_price: number;
          description: string | null;
          id: string;
          name: string;
          public: boolean;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          archived_at?: string | null;
          category_id?: string | null;
          created_at?: string;
          currency?: string;
          default_direct_cost?: number;
          default_sale_price: number;
          description?: string | null;
          id?: string;
          name: string;
          public?: boolean;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          archived_at?: string | null;
          category_id?: string | null;
          created_at?: string;
          currency?: string;
          default_direct_cost?: number;
          default_sale_price?: number;
          description?: string | null;
          id?: string;
          name?: string;
          public?: boolean;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "services_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["id"];
          },
        ];
      };
      settlement_lines: {
        Row: {
          amount_applied: number;
          consignment_item_id: string;
          created_at: string;
          id: string;
          override_reason: string | null;
          settlement_id: string;
        };
        Insert: {
          amount_applied: number;
          consignment_item_id: string;
          created_at?: string;
          id?: string;
          override_reason?: string | null;
          settlement_id: string;
        };
        Update: {
          amount_applied?: number;
          consignment_item_id?: string;
          created_at?: string;
          id?: string;
          override_reason?: string | null;
          settlement_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "settlement_lines_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "settlement_lines_settlement_id_fkey";
            columns: ["settlement_id"];
            isOneToOne: false;
            referencedRelation: "consignment_settlements";
            referencedColumns: ["id"];
          },
        ];
      };
      shop_hours: {
        Row: {
          active: boolean;
          closes_at: string;
          created_at: string;
          id: string;
          opens_at: string;
          updated_at: string;
          weekday: number;
        };
        Insert: {
          active?: boolean;
          closes_at: string;
          created_at?: string;
          id?: string;
          opens_at: string;
          updated_at?: string;
          weekday: number;
        };
        Update: {
          active?: boolean;
          closes_at?: string;
          created_at?: string;
          id?: string;
          opens_at?: string;
          updated_at?: string;
          weekday?: number;
        };
        Relationships: [];
      };
      shop_settings: {
        Row: {
          booking_horizon_days: number;
          booking_min_notice_minutes: number;
          consignment_settlement_alert_days: number;
          customer_cancel_cutoff_minutes: number;
          customer_max_active_bookings: number;
          default_currency: string;
          id: number;
          intake_capacity_units: number;
          intake_slot_minutes: number;
          public_site_url: string | null;
          timezone: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          booking_horizon_days?: number;
          booking_min_notice_minutes?: number;
          consignment_settlement_alert_days?: number;
          customer_cancel_cutoff_minutes?: number;
          customer_max_active_bookings?: number;
          default_currency?: string;
          id?: number;
          intake_capacity_units?: number;
          intake_slot_minutes?: number;
          public_site_url?: string | null;
          timezone?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          booking_horizon_days?: number;
          booking_min_notice_minutes?: number;
          consignment_settlement_alert_days?: number;
          customer_cancel_cutoff_minutes?: number;
          customer_max_active_bookings?: number;
          default_currency?: string;
          id?: number;
          intake_capacity_units?: number;
          intake_slot_minutes?: number;
          public_site_url?: string | null;
          timezone?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "shop_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      shopify_product_sync: {
        Row: {
          api_version: string | null;
          created_at: string;
          desired_hash: string | null;
          last_checked_at: string | null;
          last_error: string | null;
          last_error_code: string | null;
          last_pushed_at: string | null;
          last_pushed_price: number | null;
          last_pushed_quantity: number | null;
          product_id: string;
          publish_changed_at: string | null;
          publish_changed_by: string | null;
          publish_online: boolean;
          shopify_handle: string | null;
          shopify_inventory_item_id: string | null;
          shopify_origin: string | null;
          sync_status: Database["public"]["Enums"]["shopify_sync_status"];
          updated_at: string;
        };
        Insert: {
          api_version?: string | null;
          created_at?: string;
          desired_hash?: string | null;
          last_checked_at?: string | null;
          last_error?: string | null;
          last_error_code?: string | null;
          last_pushed_at?: string | null;
          last_pushed_price?: number | null;
          last_pushed_quantity?: number | null;
          product_id: string;
          publish_changed_at?: string | null;
          publish_changed_by?: string | null;
          publish_online?: boolean;
          shopify_handle?: string | null;
          shopify_inventory_item_id?: string | null;
          shopify_origin?: string | null;
          sync_status?: Database["public"]["Enums"]["shopify_sync_status"];
          updated_at?: string;
        };
        Update: {
          api_version?: string | null;
          created_at?: string;
          desired_hash?: string | null;
          last_checked_at?: string | null;
          last_error?: string | null;
          last_error_code?: string | null;
          last_pushed_at?: string | null;
          last_pushed_price?: number | null;
          last_pushed_quantity?: number | null;
          product_id?: string;
          publish_changed_at?: string | null;
          publish_changed_by?: string | null;
          publish_online?: boolean;
          shopify_handle?: string | null;
          shopify_inventory_item_id?: string | null;
          shopify_origin?: string | null;
          sync_status?: Database["public"]["Enums"]["shopify_sync_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shopify_product_sync_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: true;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "shopify_product_sync_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: true;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shopify_product_sync_publish_changed_by_fkey";
            columns: ["publish_changed_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      shopify_settings: {
        Row: {
          accept_test_orders: boolean;
          id: number;
          online_location_id: string;
          shopify_location_id: string | null;
          storefront_url: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          accept_test_orders?: boolean;
          id?: number;
          online_location_id: string;
          shopify_location_id?: string | null;
          storefront_url?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          accept_test_orders?: boolean;
          id?: number;
          online_location_id?: string;
          shopify_location_id?: string | null;
          storefront_url?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "shopify_settings_online_location_id_fkey";
            columns: ["online_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shopify_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      staff: {
        Row: {
          active: boolean;
          auth_user_id: string;
          created_at: string;
          display_name: string;
          email: string;
          id: string;
          role: Database["public"]["Enums"]["staff_role"];
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          auth_user_id: string;
          created_at?: string;
          display_name: string;
          email: string;
          id?: string;
          role?: Database["public"]["Enums"]["staff_role"];
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          auth_user_id?: string;
          created_at?: string;
          display_name?: string;
          email?: string;
          id?: string;
          role?: Database["public"]["Enums"]["staff_role"];
          updated_at?: string;
        };
        Relationships: [];
      };
      staff_events: {
        Row: {
          actor_staff_id: string | null;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["staff_event_type"];
          id: string;
          payload: NonNullable<Json>;
          permission: Database["public"]["Enums"]["permission_key"] | null;
          reason: string | null;
          staff_id: string;
        };
        Insert: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["staff_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          permission?: Database["public"]["Enums"]["permission_key"] | null;
          reason?: string | null;
          staff_id: string;
        };
        Update: {
          actor_staff_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["staff_event_type"];
          id?: string;
          payload?: NonNullable<Json>;
          permission?: Database["public"]["Enums"]["permission_key"] | null;
          reason?: string | null;
          staff_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "staff_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_events_staff_id_fkey";
            columns: ["staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      staff_permissions: {
        Row: {
          granted_at: string;
          granted_by: string | null;
          permission: Database["public"]["Enums"]["permission_key"];
          staff_id: string;
        };
        Insert: {
          granted_at?: string;
          granted_by?: string | null;
          permission: Database["public"]["Enums"]["permission_key"];
          staff_id: string;
        };
        Update: {
          granted_at?: string;
          granted_by?: string | null;
          permission?: Database["public"]["Enums"]["permission_key"];
          staff_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "staff_permissions_granted_by_fkey";
            columns: ["granted_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_permissions_staff_id_fkey";
            columns: ["staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      stripe_events: {
        Row: {
          api_version: string | null;
          body_bytes: number | null;
          body_sha256: string | null;
          correlation_id: string | null;
          delivery_count: number;
          event_type: string;
          headers: NonNullable<Json>;
          id: string;
          last_delivered_at: string;
          livemode: boolean | null;
          object_id: string | null;
          object_type: string | null;
          outcome: string | null;
          payload: Json | null;
          payment_id: string | null;
          processed_at: string | null;
          received_at: string;
          rejection_reason: Database["public"]["Enums"]["stripe_rejection_reason"] | null;
          source: Database["public"]["Enums"]["stripe_event_source"];
          status: Database["public"]["Enums"]["stripe_event_status"];
          stripe_created_at: string | null;
          stripe_event_id: string | null;
          work_order_id: string | null;
        };
        Insert: {
          api_version?: string | null;
          body_bytes?: number | null;
          body_sha256?: string | null;
          correlation_id?: string | null;
          delivery_count?: number;
          event_type: string;
          headers?: NonNullable<Json>;
          id?: string;
          last_delivered_at?: string;
          livemode?: boolean | null;
          object_id?: string | null;
          object_type?: string | null;
          outcome?: string | null;
          payload?: Json | null;
          payment_id?: string | null;
          processed_at?: string | null;
          received_at?: string;
          rejection_reason?: Database["public"]["Enums"]["stripe_rejection_reason"] | null;
          source: Database["public"]["Enums"]["stripe_event_source"];
          status: Database["public"]["Enums"]["stripe_event_status"];
          stripe_created_at?: string | null;
          stripe_event_id?: string | null;
          work_order_id?: string | null;
        };
        Update: {
          api_version?: string | null;
          body_bytes?: number | null;
          body_sha256?: string | null;
          correlation_id?: string | null;
          delivery_count?: number;
          event_type?: string;
          headers?: NonNullable<Json>;
          id?: string;
          last_delivered_at?: string;
          livemode?: boolean | null;
          object_id?: string | null;
          object_type?: string | null;
          outcome?: string | null;
          payload?: Json | null;
          payment_id?: string | null;
          processed_at?: string | null;
          received_at?: string;
          rejection_reason?: Database["public"]["Enums"]["stripe_rejection_reason"] | null;
          source?: Database["public"]["Enums"]["stripe_event_source"];
          status?: Database["public"]["Enums"]["stripe_event_status"];
          stripe_created_at?: string | null;
          stripe_event_id?: string | null;
          work_order_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "stripe_events_payment_fk";
            columns: ["payment_id"];
            isOneToOne: false;
            referencedRelation: "payments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stripe_events_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "stripe_events_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "stripe_events_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      supplier_products: {
        Row: {
          created_at: string;
          currency: string;
          last_received_at: string | null;
          last_unit_cost: number | null;
          lead_days: number | null;
          preferred: boolean;
          product_id: string;
          supplier_id: string;
          supplier_sku: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          currency: string;
          last_received_at?: string | null;
          last_unit_cost?: number | null;
          lead_days?: number | null;
          preferred?: boolean;
          product_id: string;
          supplier_id: string;
          supplier_sku?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          currency?: string;
          last_received_at?: string | null;
          last_unit_cost?: number | null;
          lead_days?: number | null;
          preferred?: boolean;
          product_id?: string;
          supplier_id?: string;
          supplier_sku?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "supplier_products_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "supplier_products_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supplier_products_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "suppliers";
            referencedColumns: ["id"];
          },
        ];
      };
      suppliers: {
        Row: {
          account_reference: string | null;
          archived_at: string | null;
          contact_name: string | null;
          created_at: string;
          email: string | null;
          id: string;
          name: string;
          notes: string | null;
          phone: string | null;
          phone_digits: string | null;
          search_text: string | null;
          updated_at: string;
          website: string | null;
        };
        Insert: {
          account_reference?: string | null;
          archived_at?: string | null;
          contact_name?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          name: string;
          notes?: string | null;
          phone?: string | null;
          phone_digits?: never;
          search_text?: never;
          updated_at?: string;
          website?: string | null;
        };
        Update: {
          account_reference?: string | null;
          archived_at?: string | null;
          contact_name?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          name?: string;
          notes?: string | null;
          phone?: string | null;
          phone_digits?: never;
          search_text?: never;
          updated_at?: string;
          website?: string | null;
        };
        Relationships: [];
      };
      work_order_assignments: {
        Row: {
          assigned_at: string;
          assigned_by: string | null;
          id: string;
          role: Database["public"]["Enums"]["assignment_role"];
          staff_id: string;
          unassigned_at: string | null;
          unassigned_by: string | null;
          work_order_id: string;
        };
        Insert: {
          assigned_at?: string;
          assigned_by?: string | null;
          id?: string;
          role: Database["public"]["Enums"]["assignment_role"];
          staff_id: string;
          unassigned_at?: string | null;
          unassigned_by?: string | null;
          work_order_id: string;
        };
        Update: {
          assigned_at?: string;
          assigned_by?: string | null;
          id?: string;
          role?: Database["public"]["Enums"]["assignment_role"];
          staff_id?: string;
          unassigned_at?: string | null;
          unassigned_by?: string | null;
          work_order_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "work_order_assignments_assigned_by_fkey";
            columns: ["assigned_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_assignments_staff_id_fkey";
            columns: ["staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_assignments_unassigned_by_fkey";
            columns: ["unassigned_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_assignments_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_assignments_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_assignments_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      work_order_events: {
        Row: {
          actor_staff_id: string | null;
          actor_user_id: string | null;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["work_order_event_type"];
          id: number;
          payload: NonNullable<Json>;
          work_order_id: string;
        };
        Insert: {
          actor_staff_id?: string | null;
          actor_user_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type: Database["public"]["Enums"]["work_order_event_type"];
          id?: never;
          payload?: NonNullable<Json>;
          work_order_id: string;
        };
        Update: {
          actor_staff_id?: string | null;
          actor_user_id?: string | null;
          correlation_id?: string | null;
          created_at?: string;
          event_type?: Database["public"]["Enums"]["work_order_event_type"];
          id?: never;
          payload?: NonNullable<Json>;
          work_order_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "work_order_events_actor_staff_id_fkey";
            columns: ["actor_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_events_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_events_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_events_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      work_order_line_items: {
        Row: {
          consignment_item_id: string | null;
          consignor_payout_snapshot: number | null;
          cost_pending: boolean;
          cost_total: number | null;
          created_at: string;
          created_by: string | null;
          cult_commons_rate_snapshot: number;
          cult_commons_share: number | null;
          currency: string;
          description_snapshot: string;
          id: string;
          line_type: Database["public"]["Enums"]["line_type"];
          quantity: number;
          sale_total: number | null;
          source_inventory_unit_id: string | null;
          source_product_id: string | null;
          source_service_id: string | null;
          unit_direct_cost_snapshot: number;
          unit_sale_price_snapshot: number;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
          work_order_id: string;
          yield_total: number | null;
        };
        Insert: {
          consignment_item_id?: string | null;
          consignor_payout_snapshot?: number | null;
          cost_pending?: boolean;
          cost_total?: never;
          created_at?: string;
          created_by?: string | null;
          cult_commons_rate_snapshot: number;
          cult_commons_share?: never;
          currency: string;
          description_snapshot: string;
          id: string;
          line_type: Database["public"]["Enums"]["line_type"];
          quantity: number;
          sale_total?: never;
          source_inventory_unit_id?: string | null;
          source_product_id?: string | null;
          source_service_id?: string | null;
          unit_direct_cost_snapshot: number;
          unit_sale_price_snapshot: number;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
          work_order_id: string;
          yield_total?: never;
        };
        Update: {
          consignment_item_id?: string | null;
          consignor_payout_snapshot?: number | null;
          cost_pending?: boolean;
          cost_total?: never;
          created_at?: string;
          created_by?: string | null;
          cult_commons_rate_snapshot?: number;
          cult_commons_share?: never;
          currency?: string;
          description_snapshot?: string;
          id?: string;
          line_type?: Database["public"]["Enums"]["line_type"];
          quantity?: number;
          sale_total?: never;
          source_inventory_unit_id?: string | null;
          source_product_id?: string | null;
          source_service_id?: string | null;
          unit_direct_cost_snapshot?: number;
          unit_sale_price_snapshot?: number;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
          work_order_id?: string;
          yield_total?: never;
        };
        Relationships: [
          {
            foreignKeyName: "work_order_line_items_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_inventory_unit_id_fkey";
            columns: ["source_inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_inventory_unit_id_fkey";
            columns: ["source_inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_product_id_fkey";
            columns: ["source_product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_product_id_fkey";
            columns: ["source_product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_service_id_fkey";
            columns: ["source_service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_service_id_fkey";
            columns: ["source_service_id"];
            isOneToOne: false;
            referencedRelation: "services_staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_voided_by_fkey";
            columns: ["voided_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_line_items_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_line_items_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      work_orders: {
        Row: {
          appointment_id: string | null;
          approval_flag: boolean;
          approval_note: string | null;
          bike_id: string;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          checked_in_at: string;
          collected_at: string | null;
          completed_at: string | null;
          completion_notes: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          customer_id: string;
          id: string;
          intake_notes: string | null;
          internal_notes: string | null;
          job_number: string;
          lead_mechanic_id: string | null;
          ready_for_collection_at: string | null;
          requested_work: string;
          started_at: string | null;
          status: Database["public"]["Enums"]["work_order_status"];
          status_changed_at: string;
          updated_at: string;
        };
        Insert: {
          appointment_id?: string | null;
          approval_flag?: boolean;
          approval_note?: string | null;
          bike_id: string;
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          checked_in_at?: string;
          collected_at?: string | null;
          completed_at?: string | null;
          completion_notes?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          customer_id: string;
          id?: string;
          intake_notes?: string | null;
          internal_notes?: string | null;
          job_number?: string;
          lead_mechanic_id?: string | null;
          ready_for_collection_at?: string | null;
          requested_work: string;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["work_order_status"];
          status_changed_at?: string;
          updated_at?: string;
        };
        Update: {
          appointment_id?: string | null;
          approval_flag?: boolean;
          approval_note?: string | null;
          bike_id?: string;
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          checked_in_at?: string;
          collected_at?: string | null;
          completed_at?: string | null;
          completion_notes?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          customer_id?: string;
          id?: string;
          intake_notes?: string | null;
          internal_notes?: string | null;
          job_number?: string;
          lead_mechanic_id?: string | null;
          ready_for_collection_at?: string | null;
          requested_work?: string;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["work_order_status"];
          status_changed_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "work_orders_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_orders_bike_id_fkey";
            columns: ["bike_id"];
            isOneToOne: false;
            referencedRelation: "bikes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_orders_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_orders_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_orders_lead_mechanic_id_fkey";
            columns: ["lead_mechanic_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      inventory_movement_costs: {
        Row: {
          currency: string | null;
          movement_id: number | null;
          unit_cost_snapshot: number | null;
        };
        Insert: {
          currency?: string | null;
          movement_id?: number | null;
          unit_cost_snapshot?: number | null;
        };
        Update: {
          currency?: string | null;
          movement_id?: number | null;
          unit_cost_snapshot?: number | null;
        };
        Relationships: [];
      };
      inventory_unit_costs: {
        Row: {
          currency: string | null;
          direct_cost: number | null;
          effective_cost: number | null;
          expected_cult_commons: number | null;
          expected_yield: number | null;
          unit_id: string | null;
        };
        Relationships: [];
      };
      job_part_requests_staff: {
        Row: {
          expected_unit_cost: number | null;
          id: string | null;
          kind: Database["public"]["Enums"]["part_request_kind"] | null;
          supplier_id: string | null;
          supplier_name: string | null;
          work_order_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_part_requests_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "suppliers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "job_part_requests_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      product_costs: {
        Row: {
          currency: string | null;
          default_direct_cost: number | null;
          expected_cult_commons: number | null;
          expected_yield: number | null;
          product_id: string | null;
        };
        Relationships: [];
      };
      purchase_order_lines_staff: {
        Row: {
          currency: string | null;
          ordered_total: number | null;
          product_id: string | null;
          purchase_order_id: string | null;
          purchase_order_line_id: string | null;
          received_value: number | null;
          unit_cost: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_order_lines_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_order_totals_staff";
            referencedColumns: ["purchase_order_id"];
          },
          {
            foreignKeyName: "purchase_order_lines_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      purchase_order_totals_staff: {
        Row: {
          currency: string | null;
          ordered_total: number | null;
          outstanding_total: number | null;
          purchase_order_id: string | null;
          received_total: number | null;
        };
        Relationships: [];
      };
      purchase_receipt_lines_staff: {
        Row: {
          currency: string | null;
          purchase_receipt_id: string | null;
          purchase_receipt_line_id: string | null;
          received_total: number | null;
          unit_cost_actual: number | null;
        };
        Insert: {
          currency?: string | null;
          purchase_receipt_id?: string | null;
          purchase_receipt_line_id?: string | null;
          received_total?: number | null;
          unit_cost_actual?: number | null;
        };
        Update: {
          currency?: string | null;
          purchase_receipt_id?: string | null;
          purchase_receipt_line_id?: string | null;
          received_total?: number | null;
          unit_cost_actual?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_receipt_lines_purchase_receipt_id_fkey";
            columns: ["purchase_receipt_id"];
            isOneToOne: false;
            referencedRelation: "purchase_receipts";
            referencedColumns: ["id"];
          },
        ];
      };
      selling_prices: {
        Row: {
          currency: string | null;
          inventory_unit_id: string | null;
          product_id: string | null;
          selling_price: number | null;
        };
        Relationships: [];
      };
      services_staff: {
        Row: {
          active: boolean | null;
          archived_at: string | null;
          category_id: string | null;
          created_at: string | null;
          currency: string | null;
          default_direct_cost: number | null;
          default_sale_price: number | null;
          description: string | null;
          id: string | null;
          name: string | null;
          public: boolean | null;
          sort_order: number | null;
          updated_at: string | null;
        };
        Insert: {
          active?: boolean | null;
          archived_at?: string | null;
          category_id?: string | null;
          created_at?: string | null;
          currency?: string | null;
          default_direct_cost?: number | null;
          default_sale_price?: number | null;
          description?: string | null;
          id?: string | null;
          name?: string | null;
          public?: boolean | null;
          sort_order?: number | null;
          updated_at?: string | null;
        };
        Update: {
          active?: boolean | null;
          archived_at?: string | null;
          category_id?: string | null;
          created_at?: string | null;
          currency?: string | null;
          default_direct_cost?: number | null;
          default_sale_price?: number | null;
          description?: string | null;
          id?: string | null;
          name?: string | null;
          public?: boolean | null;
          sort_order?: number | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "services_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["id"];
          },
        ];
      };
      supplier_products_staff: {
        Row: {
          currency: string | null;
          last_received_at: string | null;
          last_unit_cost: number | null;
          product_id: string | null;
          supplier_id: string | null;
        };
        Insert: {
          currency?: string | null;
          last_received_at?: string | null;
          last_unit_cost?: number | null;
          product_id?: string | null;
          supplier_id?: string | null;
        };
        Update: {
          currency?: string | null;
          last_received_at?: string | null;
          last_unit_cost?: number | null;
          product_id?: string | null;
          supplier_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "supplier_products_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "supplier_products_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supplier_products_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "suppliers";
            referencedColumns: ["id"];
          },
        ];
      };
      work_order_line_items_staff: {
        Row: {
          consignment_item_id: string | null;
          consignor_payout_snapshot: number | null;
          cost_pending: boolean | null;
          cost_total: number | null;
          created_at: string | null;
          created_by: string | null;
          cult_commons_rate_snapshot: number | null;
          cult_commons_share: number | null;
          currency: string | null;
          description_snapshot: string | null;
          id: string | null;
          line_type: Database["public"]["Enums"]["line_type"] | null;
          quantity: number | null;
          sale_total: number | null;
          source_inventory_unit_id: string | null;
          source_product_id: string | null;
          source_service_id: string | null;
          unit_direct_cost_snapshot: number | null;
          unit_sale_price_snapshot: number | null;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
          work_order_id: string | null;
          yield_total: number | null;
        };
        Insert: {
          consignment_item_id?: string | null;
          consignor_payout_snapshot?: number | null;
          cost_pending?: boolean | null;
          cost_total?: number | null;
          created_at?: string | null;
          created_by?: string | null;
          cult_commons_rate_snapshot?: number | null;
          cult_commons_share?: number | null;
          currency?: string | null;
          description_snapshot?: string | null;
          id?: string | null;
          line_type?: Database["public"]["Enums"]["line_type"] | null;
          quantity?: number | null;
          sale_total?: number | null;
          source_inventory_unit_id?: string | null;
          source_product_id?: string | null;
          source_service_id?: string | null;
          unit_direct_cost_snapshot?: number | null;
          unit_sale_price_snapshot?: number | null;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
          work_order_id?: string | null;
          yield_total?: number | null;
        };
        Update: {
          consignment_item_id?: string | null;
          consignor_payout_snapshot?: number | null;
          cost_pending?: boolean | null;
          cost_total?: number | null;
          created_at?: string | null;
          created_by?: string | null;
          cult_commons_rate_snapshot?: number | null;
          cult_commons_share?: number | null;
          currency?: string | null;
          description_snapshot?: string | null;
          id?: string | null;
          line_type?: Database["public"]["Enums"]["line_type"] | null;
          quantity?: number | null;
          sale_total?: number | null;
          source_inventory_unit_id?: string | null;
          source_product_id?: string | null;
          source_service_id?: string | null;
          unit_direct_cost_snapshot?: number | null;
          unit_sale_price_snapshot?: number | null;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
          work_order_id?: string | null;
          yield_total?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "work_order_line_items_consignment_item_id_fkey";
            columns: ["consignment_item_id"];
            isOneToOne: false;
            referencedRelation: "consignment_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_inventory_unit_id_fkey";
            columns: ["source_inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_unit_costs";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_inventory_unit_id_fkey";
            columns: ["source_inventory_unit_id"];
            isOneToOne: false;
            referencedRelation: "inventory_units";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_product_id_fkey";
            columns: ["source_product_id"];
            isOneToOne: false;
            referencedRelation: "product_costs";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_product_id_fkey";
            columns: ["source_product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_service_id_fkey";
            columns: ["source_service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_source_service_id_fkey";
            columns: ["source_service_id"];
            isOneToOne: false;
            referencedRelation: "services_staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_voided_by_fkey";
            columns: ["voided_by"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_order_line_items_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_line_items_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_order_totals_staff";
            referencedColumns: ["work_order_id"];
          },
          {
            foreignKeyName: "work_order_line_items_work_order_id_fkey";
            columns: ["work_order_id"];
            isOneToOne: false;
            referencedRelation: "work_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      work_order_totals: {
        Row: {
          currency: string | null;
          line_count: number | null;
          sale_total: number | null;
          work_order_id: string | null;
        };
        Relationships: [];
      };
      work_order_totals_staff: {
        Row: {
          bicii_yield_after_cc: number | null;
          cost_pending_count: number | null;
          cost_total: number | null;
          cult_commons_share: number | null;
          currency: string | null;
          line_count: number | null;
          sale_total: number | null;
          work_order_id: string | null;
          yield_total: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      add_consignment_charge: {
        Args: {
          amount: unknown;
          bearer: Database["public"]["Enums"]["charge_bearer"];
          charge_id: string;
          description: string;
          item_id: string;
          work_order_id?: string;
        };
        Returns: {
          amount: number;
          bearer: Database["public"]["Enums"]["charge_bearer"];
          consignment_item_id: string;
          created_at: string;
          created_by: string | null;
          currency: string;
          description: string;
          id: string;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
          work_order_id: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "consignment_item_charges";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      add_inventory_line: {
        Args: {
          inventory_unit_id?: string;
          line_id: string;
          location_id?: string;
          product_id: string;
          quantity?: number;
          unit_sale_price?: unknown;
          work_order_id: string;
        };
        Returns: Database["public"]["CompositeTypes"]["inventory_line_result"];
        SetofOptions: {
          from: "*";
          to: "inventory_line_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      add_manual_line: {
        Args: {
          description: string;
          line_id: string;
          quantity?: unknown;
          unit_direct_cost?: unknown;
          unit_sale_price: unknown;
          work_order_id: string;
        };
        Returns: string;
      };
      add_service_line: {
        Args: {
          description?: string;
          line_id: string;
          quantity?: unknown;
          service_id: string;
          unit_direct_cost?: unknown;
          unit_sale_price?: unknown;
          work_order_id: string;
        };
        Returns: string;
      };
      add_work_order_note: {
        Args: {
          body: string;
          kind: Database["public"]["Enums"]["work_order_note_kind"];
          note_id: string;
          work_order_id: string;
        };
        Returns: {
          actor_staff_id: string | null;
          actor_user_id: string | null;
          correlation_id: string | null;
          created_at: string;
          event_type: Database["public"]["Enums"]["work_order_event_type"];
          id: number;
          payload: NonNullable<Json>;
          work_order_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "work_order_events";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      adjust_stock: {
        Args: {
          location_id: string;
          movement_type: Database["public"]["Enums"]["movement_type"];
          product_id: string;
          quantity_delta: number;
          reason: string;
          request_id: string;
          unit_cost?: unknown;
        };
        Returns: {
          movement_id: number;
          on_hand: number;
        }[];
      };
      answer_quote: { Args: { decisions: Json; name: string; token: string }; Returns: Json };
      appointment_daily: {
        Args: { from_day?: string; to_day?: string };
        Returns: {
          arrived: number;
          booked: number;
          cancelled: number;
          checked_in: number;
          day: string;
          expected: number;
          no_shows: number;
        }[];
      };
      assign_staff: {
        Args: {
          role?: Database["public"]["Enums"]["assignment_role"];
          staff_id: string;
          work_order_id: string;
        };
        Returns: {
          assigned_at: string;
          assigned_by: string | null;
          id: string;
          role: Database["public"]["Enums"]["assignment_role"];
          staff_id: string;
          unassigned_at: string | null;
          unassigned_by: string | null;
          work_order_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "work_order_assignments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      attachment_stray_objects: {
        Args: { entity_id: string; entity_type: Database["public"]["Enums"]["attachment_entity"] };
        Returns: {
          bucket: string;
          path: string;
        }[];
      };
      available_slots: {
        Args: { appointment_type_id: string; day: string };
        Returns: {
          remaining_units: number;
          slot_end: string;
          slot_start: string;
        }[];
      };
      book_appointment: {
        Args: {
          appointment_id: string;
          appointment_type_id: string;
          bike_id?: string;
          customer_id: string;
          customer_note?: string;
          internal_note?: string;
          starts_at: string;
        };
        Returns: {
          appointment_type_id: string;
          arrived_at: string | null;
          bike_id: string | null;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_via: Database["public"]["Enums"]["appointment_source"] | null;
          capacity_units: number;
          checked_in_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          created_by_staff_id: string | null;
          created_by_user_id: string | null;
          customer_id: string;
          customer_note: string | null;
          ends_at: string;
          id: string;
          internal_note: string | null;
          no_show_at: string | null;
          source: Database["public"]["Enums"]["appointment_source"];
          starts_at: string;
          status: Database["public"]["Enums"]["appointment_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "appointments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      book_my_appointment: {
        Args: {
          appointment_id: string;
          appointment_type_id: string;
          bike_id?: string;
          customer_note?: string;
          starts_at: string;
        };
        Returns: Database["public"]["CompositeTypes"]["my_appointment"];
        SetofOptions: {
          from: "*";
          to: "my_appointment";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      bookable_slots: {
        Args: { appointment_type_id: string; from_day: string; to_day: string };
        Returns: {
          slot_day: string;
          slot_end: string;
          slot_start: string;
        }[];
      };
      cancel_appointment: {
        Args: { appointment_id: string; reason: string };
        Returns: {
          appointment_type_id: string;
          arrived_at: string | null;
          bike_id: string | null;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_via: Database["public"]["Enums"]["appointment_source"] | null;
          capacity_units: number;
          checked_in_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          created_by_staff_id: string | null;
          created_by_user_id: string | null;
          customer_id: string;
          customer_note: string | null;
          ends_at: string;
          id: string;
          internal_note: string | null;
          no_show_at: string | null;
          source: Database["public"]["Enums"]["appointment_source"];
          starts_at: string;
          status: Database["public"]["Enums"]["appointment_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "appointments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      cancel_cult_commons_rate: {
        Args: { rate_id: string };
        Returns: {
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          effective_from: string;
          id: string;
          rate: number;
        };
        SetofOptions: {
          from: "*";
          to: "cult_commons_rates";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      cancel_my_appointment: {
        Args: { appointment_id: string; reason?: string };
        Returns: Database["public"]["CompositeTypes"]["my_appointment"];
        SetofOptions: {
          from: "*";
          to: "my_appointment";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      cancel_part_request: { Args: { reason: string; request_id: string }; Returns: string };
      cancel_purchase_order: {
        Args: { purchase_order_id: string; reason: string };
        Returns: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          po_number: string;
          received_at: string | null;
          status: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          supplier_id: string;
          supplier_reference: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "purchase_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      check_in_appointment: {
        Args: {
          appointment_id: string;
          bike_id: string;
          intake_notes?: string;
          lead_mechanic_id?: string;
          link_existing?: boolean;
          requested_work?: string;
          work_order_id: string;
        };
        Returns: Database["public"]["CompositeTypes"]["appointment_check_in"];
        SetofOptions: {
          from: "*";
          to: "appointment_check_in";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      claim_integration_jobs: {
        Args: { max_jobs: number; only_job_id?: string };
        Returns: {
          attempts: number;
          created_at: string;
          id: string;
          integration_event_id: string | null;
          kind: Database["public"]["Enums"]["integration_job_kind"];
          last_error: string | null;
          last_error_code: string | null;
          last_retried_at: string | null;
          last_retried_by: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          product_id: string | null;
          resolution_reason: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: Database["public"]["Enums"]["integration_job_status"];
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "integration_retry_queue";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_my_customer: {
        Args: {
          create_if_missing?: boolean;
          first_name?: string;
          last_name?: string;
          phone?: string;
        };
        Returns: Database["public"]["CompositeTypes"]["customer_profile"][];
        SetofOptions: {
          from: "*";
          to: "customer_profile";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      consignor_payout_details: { Args: { consignor_id: string }; Returns: string };
      consignor_statement: {
        Args: { target_consignor_id?: string; target_item_id?: string };
        Returns: {
          agreed_amount_owed: number;
          asking_price: number;
          bike_id: string;
          bike_short_id: string;
          consignor_charges: number;
          consignor_id: string;
          consignor_name: string;
          inventory_unit_id: string;
          item_id: string;
          job_held_qty: number;
          job_sold_qty: number;
          last_sale_at: string;
          last_settlement_at: string;
          liability: number;
          outstanding: number;
          owed: number;
          paid: number;
          product_id: string;
          product_name: string;
          product_short_id: string;
          quantity: number;
          received_at: string;
          remaining_qty: number;
          restocked_qty: number;
          return_reason: string;
          returned_at: string;
          returned_qty: number;
          shop_charges: number;
          short_id: string;
          sold_at: string;
          sold_qty: number;
          status: Database["public"]["Enums"]["consignment_status"];
          unit_short_id: string;
          unit_status: Database["public"]["Enums"]["unit_status"];
        }[];
      };
      create_consignment_item: {
        Args: {
          agreed_amount_owed: unknown;
          agreement_notes?: string;
          asking_price?: unknown;
          bike_id?: string;
          brand?: string;
          category_id?: string;
          condition?: string;
          consignor_id: string;
          description?: string;
          internal_notes?: string;
          item_id: string;
          location_id: string;
          new_consignor?: Json;
          new_product_id?: string;
          new_unit_id?: string;
          product_id?: string;
          product_name?: string;
          quantity?: number;
          received_at?: string;
          serial_number?: string;
          tracking_type?: Database["public"]["Enums"]["tracking_type"];
        };
        Returns: Database["public"]["CompositeTypes"]["consignment_item_result"];
        SetofOptions: {
          from: "*";
          to: "consignment_item_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_print_job: {
        Args: {
          entity_id: string;
          job_id: string;
          kind: Database["public"]["Enums"]["label_kind"];
          label_template_id?: string;
          printer_profile_id?: string;
          quantity: number;
          reprint_of_id?: string;
        };
        Returns: {
          adapter: Database["public"]["Enums"]["printer_adapter"];
          bike_id: string | null;
          completed_at: string | null;
          content: NonNullable<Json>;
          correlation_id: string | null;
          created_at: string;
          error: string | null;
          id: string;
          inventory_unit_id: string | null;
          label_kind: Database["public"]["Enums"]["label_kind"];
          label_template_id: string;
          printer_profile_id: string;
          product_id: string | null;
          profile_snapshot: NonNullable<Json>;
          qr_payload: string;
          quantity: number;
          rendered_at: string | null;
          reprint_of_id: string | null;
          requested_by: string;
          short_id: string;
          status: Database["public"]["Enums"]["print_status"];
          status_changed_by: string | null;
          template_snapshot: NonNullable<Json>;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "print_jobs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_purchase_order: {
        Args: {
          expected_at?: string;
          id: string;
          notes?: string;
          supplier_id: string;
          supplier_reference?: string;
        };
        Returns: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          po_number: string;
          received_at: string | null;
          status: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          supplier_id: string;
          supplier_reference: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "purchase_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_purchase_order_from_low_stock: {
        Args: { id: string; product_ids: string[]; supplier_id: string };
        Returns: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          po_number: string;
          received_at: string | null;
          status: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          supplier_id: string;
          supplier_reference: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "purchase_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_service: {
        Args: {
          category_id?: string;
          default_direct_cost?: unknown;
          default_sale_price: unknown;
          description?: string;
          is_active?: boolean;
          is_public?: boolean;
          name: string;
          service_id: string;
        };
        Returns: string;
      };
      create_staff: {
        Args: {
          auth_user_id: string;
          display_name: string;
          email: string;
          role?: Database["public"]["Enums"]["staff_role"];
        };
        Returns: {
          active: boolean;
          auth_user_id: string;
          created_at: string;
          display_name: string;
          email: string;
          id: string;
          role: Database["public"]["Enums"]["staff_role"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "staff";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_unique_unit: {
        Args: {
          bike_id?: string;
          condition?: string;
          direct_cost?: unknown;
          location_id: string;
          product_id: string;
          reason?: string;
          sale_price?: unknown;
          serial_number?: string;
          unit_id: string;
        };
        Returns: Database["public"]["CompositeTypes"]["unique_unit_result"];
        SetofOptions: {
          from: "*";
          to: "unique_unit_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_work_order: {
        Args: {
          additional_staff_ids?: string[];
          bike_id: string;
          customer_id: string;
          intake_notes?: string;
          lead_mechanic_id?: string;
          requested_work: string;
          services?: Json;
          work_order_id: string;
        };
        Returns: {
          appointment_id: string | null;
          approval_flag: boolean;
          approval_note: string | null;
          bike_id: string;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          checked_in_at: string;
          collected_at: string | null;
          completed_at: string | null;
          completion_notes: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          customer_id: string;
          id: string;
          intake_notes: string | null;
          internal_notes: string | null;
          job_number: string;
          lead_mechanic_id: string | null;
          ready_for_collection_at: string | null;
          requested_work: string;
          started_at: string | null;
          status: Database["public"]["Enums"]["work_order_status"];
          status_changed_at: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "work_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      daily_summary: {
        Args: { from_day?: string; to_day?: string };
        Returns: {
          appointments_arrived: number;
          appointments_no_show: number;
          appointments_scheduled: number;
          bicii_yield_after_cc: number;
          cogs: number;
          consignment_sales: number;
          consignment_sales_total: number;
          cult_commons_share: number;
          currency: string;
          day: string;
          gross_sales: number;
          jobs_cancelled: number;
          jobs_checked_in: number;
          jobs_collected: number;
          jobs_completed: number;
          jobs_ready_for_collection: number;
          jobs_started: number;
          lines_recognised: number;
          loss_lines: number;
          loss_total: number;
          new_consignor_liability: number;
          parts_consumed_lines: number;
          parts_consumed_qty: number;
          parts_returned_qty: number;
          significant_stock_adjustments: number;
          stock_adjustments: number;
          yield_total: number;
        }[];
      };
      delete_attachment: {
        Args: { attachment_id: string; reason: string };
        Returns: {
          byte_size: number | null;
          caption: string | null;
          created_at: string;
          created_by: string | null;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          height: number | null;
          id: string;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          updated_at: string;
          visibility: Database["public"]["Enums"]["attachment_visibility"];
          width: number | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "attachments";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      delete_closure_override: {
        Args: { closure_id: string; reason: string };
        Returns: {
          closes_at: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          id: string;
          kind: Database["public"]["Enums"]["closure_kind"];
          opens_at: string | null;
          reason: string;
          starts_at: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "closure_overrides";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      dismiss_integration_job: {
        Args: { job_id: string; reason: string };
        Returns: {
          attempts: number;
          created_at: string;
          id: string;
          integration_event_id: string | null;
          kind: Database["public"]["Enums"]["integration_job_kind"];
          last_error: string | null;
          last_error_code: string | null;
          last_retried_at: string | null;
          last_retried_by: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          product_id: string | null;
          resolution_reason: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: Database["public"]["Enums"]["integration_job_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "integration_retry_queue";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      financial_lines: {
        Args: { from_day: string; to_day: string };
        Returns: {
          bicii_yield_after_cc: number;
          bike_id: string;
          category_id: string;
          channel: string;
          consignment_item_id: string;
          cost_pending: boolean;
          cost_total: number;
          cult_commons_rate: number;
          cult_commons_share: number;
          currency: string;
          customer_id: string;
          description: string;
          document_id: string;
          document_number: string;
          entry_key: string;
          entry_kind: string;
          inventory_unit_id: string;
          is_loss: boolean;
          lead_mechanic_id: string;
          line_type: string;
          ownership_type: string;
          product_id: string;
          quantity: number;
          recognized_at: string;
          recognized_day: string;
          sale_total: number;
          service_id: string;
          source: string;
          source_line_id: string;
          unit_direct_cost: number;
          unit_sale_price: number;
          yield_total: number;
        }[];
      };
      fit_part_request: {
        Args: { line_id: string; location_id?: string; request_id: string };
        Returns: string;
      };
      grant_permission: {
        Args: {
          permission: Database["public"]["Enums"]["permission_key"];
          target_staff_id: string;
        };
        Returns: {
          granted_at: string;
          granted_by: string | null;
          permission: Database["public"]["Enums"]["permission_key"];
          staff_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "staff_permissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      indent_reservations: {
        Args: { product_id: string };
        Returns: {
          job_number: string;
          quantity: number;
          work_order_id: string;
        }[];
      };
      label_preview: {
        Args: { entity_id: string; kind: Database["public"]["Enums"]["label_kind"] };
        Returns: Json;
      };
      link_shopify_customer: {
        Args: { customer_id: string; reason: string; shopify_customer_id: string };
        Returns: Database["public"]["CompositeTypes"]["shopify_customer_link_result"];
        SetofOptions: {
          from: "*";
          to: "shopify_customer_link_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      link_shopify_variant: {
        Args: {
          product_id: string;
          reason: string;
          shopify_product_id: string;
          shopify_variant_id: string;
        };
        Returns: {
          api_version: string | null;
          created_at: string;
          desired_hash: string | null;
          last_checked_at: string | null;
          last_error: string | null;
          last_error_code: string | null;
          last_pushed_at: string | null;
          last_pushed_price: number | null;
          last_pushed_quantity: number | null;
          product_id: string;
          publish_changed_at: string | null;
          publish_changed_by: string | null;
          publish_online: boolean;
          shopify_handle: string | null;
          shopify_inventory_item_id: string | null;
          shopify_origin: string | null;
          sync_status: Database["public"]["Enums"]["shopify_sync_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "shopify_product_sync";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      list_consignors: {
        Args: { include_archived?: boolean; max_rows?: number; q?: string };
        Returns: {
          active_items: number;
          archived_at: string;
          awaiting_settlement_items: number;
          customer_id: string;
          customer_label: string;
          display_name: string;
          email: string;
          id: string;
          last_sale_at: string;
          last_settlement_at: string;
          outstanding: number;
          owed: number;
          paid: number;
          phone: string;
          returned_items: number;
          sold_items: number;
        }[];
      };
      list_sales: {
        Args: { from_at?: string; max_rows?: number; q?: string; to_at?: string };
        Returns: {
          cost_total: number;
          cult_commons_share: number;
          customer_id: string;
          customer_label: string;
          first_description: string;
          has_consignment: boolean;
          id: string;
          line_count: number;
          recognized_at: string;
          refunded_total: number;
          restocked_lines: number;
          sale_number: string;
          sale_total: number;
          source: Database["public"]["Enums"]["sale_source"];
          status: Database["public"]["Enums"]["sale_status"];
          yield_total: number;
        }[];
      };
      mark_appointment_status: {
        Args: {
          appointment_id: string;
          reason?: string;
          status: Database["public"]["Enums"]["appointment_status"];
        };
        Returns: {
          appointment_type_id: string;
          arrived_at: string | null;
          bike_id: string | null;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_via: Database["public"]["Enums"]["appointment_source"] | null;
          capacity_units: number;
          checked_in_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          created_by_staff_id: string | null;
          created_by_user_id: string | null;
          customer_id: string;
          customer_note: string | null;
          ends_at: string;
          id: string;
          internal_note: string | null;
          no_show_at: string | null;
          source: Database["public"]["Enums"]["appointment_source"];
          starts_at: string;
          status: Database["public"]["Enums"]["appointment_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "appointments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      my_appointments: {
        Args: { include_past?: boolean };
        Returns: Database["public"]["CompositeTypes"]["my_appointment"][];
        SetofOptions: {
          from: "*";
          to: "my_appointment";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      my_bike_attachments: {
        Args: { bike_id: string };
        Returns: {
          caption: string;
          created_at: string;
          height: number;
          id: string;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          visibility: Database["public"]["Enums"]["attachment_visibility"];
          width: number;
        }[];
      };
      my_bikes: {
        Args: Record<PropertyKey, never>;
        Returns: {
          brand: string;
          colour: string;
          created_at: string;
          description: string;
          frame_size: string;
          id: string;
          model: string;
          serial_number: string;
          short_id: string;
          variant: string;
        }[];
      };
      my_customer_profile: {
        Args: Record<PropertyKey, never>;
        Returns: Database["public"]["CompositeTypes"]["customer_profile"][];
        SetofOptions: {
          from: "*";
          to: "customer_profile";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      my_staff_profile: {
        Args: Record<PropertyKey, never>;
        Returns: {
          active: boolean;
          auth_user_id: string;
          display_name: string;
          email: string;
          id: string;
          permissions: Database["public"]["Enums"]["permission_key"][];
          role: Database["public"]["Enums"]["staff_role"];
        }[];
      };
      my_work_order_attachments: {
        Args: { work_order_id: string };
        Returns: {
          caption: string;
          created_at: string;
          height: number;
          id: string;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          visibility: Database["public"]["Enums"]["attachment_visibility"];
          width: number;
        }[];
      };
      my_work_order_lines: {
        Args: { work_order_id: string };
        Returns: {
          currency: string;
          description: string;
          id: string;
          quantity: unknown;
          sale_total: unknown;
          unit_sale_price: unknown;
        }[];
      };
      my_work_order_timeline: {
        Args: { work_order_id: string };
        Returns: {
          attachment_id: string;
          created_at: string;
          id: number;
          kind: string;
          status: Database["public"]["Enums"]["customer_job_status"];
        }[];
      };
      my_work_orders: {
        Args: Record<PropertyKey, never>;
        Returns: {
          bike_id: string;
          bike_short_id: string;
          bike_title: string;
          checked_in_at: string;
          collected_at: string;
          completed_at: string;
          currency: string;
          id: string;
          job_number: string;
          ready_for_collection_at: string;
          sale_total: unknown;
          status: Database["public"]["Enums"]["customer_job_status"];
        }[];
      };
      note_sign_in_attempt: {
        Args: { buckets: string[]; window_seconds: number };
        Returns: {
          bucket_key: string;
          hit_count: number;
        }[];
      };
      operational_exceptions: {
        Args: { max_rows?: number };
        Returns: {
          amount: number;
          currency: string;
          days: number;
          detail: string;
          entity_id: string;
          entity_label: string;
          entity_type: string;
          issue: string;
          kind: string;
          quantity: number;
          severity: string;
          short_id: string;
          since: string;
          subject_label: string;
          title: string;
        }[];
      };
      order_part_requests: {
        Args: {
          move_to_waiting?: boolean;
          purchase_order_id: string;
          request_ids: string[];
          supplier_id: string;
        };
        Returns: string;
      };
      part_request_arrivals: {
        Args: { work_order_id: string };
        Returns: {
          arrived: boolean;
          location_id: string;
          po_number: string;
          purchase_order_id: string;
          request_id: string;
        }[];
      };
      process_shopify_event: {
        Args: { event_id: string };
        Returns: {
          error_code: string;
          error_message: string;
          event_status: Database["public"]["Enums"]["integration_event_status"];
          outcome: string;
          sale_id: string;
        }[];
      };
      process_shopify_order_paid: {
        Args: { event_id: string };
        Returns: {
          error_code: string;
          error_message: string;
          event_status: Database["public"]["Enums"]["integration_event_status"];
          outcome: string;
          sale_id: string;
        }[];
      };
      process_shopify_refund: {
        Args: { event_id: string };
        Returns: {
          error_code: string;
          error_message: string;
          event_status: Database["public"]["Enums"]["integration_event_status"];
          outcome: string;
          sale_id: string;
        }[];
      };
      product_sync_state: {
        Args: { product_id: string };
        Returns: Database["public"]["CompositeTypes"]["shopify_product_sync_state"];
        SetofOptions: {
          from: "*";
          to: "shopify_product_sync_state";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      propose_part: {
        Args: {
          expected_unit_cost?: unknown;
          product_id: string;
          quantity?: number;
          request_id: string;
          supplier_id?: string;
          unit_sale_price?: unknown;
          work_order_id: string;
        };
        Returns: string;
      };
      propose_service: {
        Args: {
          quantity?: unknown;
          request_id: string;
          service_id: string;
          unit_sale_price?: unknown;
          work_order_id: string;
        };
        Returns: string;
      };
      public_appointment_types: {
        Args: Record<PropertyKey, never>;
        Returns: {
          description: string;
          duration_minutes: number;
          id: string;
          name: string;
        }[];
      };
      public_shop_hours: {
        Args: Record<PropertyKey, never>;
        Returns: {
          closes_at: string;
          opens_at: string;
          weekday: number;
        }[];
      };
      purchase_cost_defaults: {
        Args: { product_ids: string[]; supplier_id: string };
        Returns: {
          product_id: string;
          source: string;
          unit_cost: unknown;
        }[];
      };
      purchase_receipt_by_key: {
        Args: { idempotency_key: string };
        Returns: {
          correlation_id: string | null;
          created_at: string;
          id: string;
          idempotency_key: string;
          notes: string | null;
          purchase_order_id: string;
          received_at: string;
          received_by: string;
          reference: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "purchase_receipts";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      quote_by_token: { Args: { token: string }; Returns: Json };
      receive_purchase: {
        Args: {
          idempotency_key: string;
          lines: Json;
          notes?: string;
          purchase_order_id: string;
          received_at?: string;
          reference?: string;
        };
        Returns: {
          correlation_id: string | null;
          created_at: string;
          id: string;
          idempotency_key: string;
          notes: string | null;
          purchase_order_id: string;
          received_at: string;
          received_by: string;
          reference: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "purchase_receipts";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_attachment: {
        Args: {
          attachment_id: string;
          byte_size?: number;
          caption?: string;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          height?: number;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          visibility?: Database["public"]["Enums"]["attachment_visibility"];
          width?: number;
        };
        Returns: {
          byte_size: number | null;
          caption: string | null;
          created_at: string;
          created_by: string | null;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          height: number | null;
          id: string;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          updated_at: string;
          visibility: Database["public"]["Enums"]["attachment_visibility"];
          width: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "attachments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_product_sync_result: {
        Args: {
          api_version: string;
          desired_hash: string;
          error_code: string;
          error_message: string;
          job_id: string;
          outcome: string;
          product_id: string;
          pushed_price: unknown;
          pushed_quantity: number;
          retriable: boolean;
          shopify_inventory_item_id: string;
          shopify_location_id: string;
          shopify_product_id: string;
          shopify_variant_id: string;
        };
        Returns: {
          api_version: string | null;
          created_at: string;
          desired_hash: string | null;
          last_checked_at: string | null;
          last_error: string | null;
          last_error_code: string | null;
          last_pushed_at: string | null;
          last_pushed_price: number | null;
          last_pushed_quantity: number | null;
          product_id: string;
          publish_changed_at: string | null;
          publish_changed_by: string | null;
          publish_online: boolean;
          shopify_handle: string | null;
          shopify_inventory_item_id: string | null;
          shopify_origin: string | null;
          sync_status: Database["public"]["Enums"]["shopify_sync_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "shopify_product_sync";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_retail_sale: {
        Args: {
          customer_id?: string;
          lines: Json;
          notes?: string;
          recognized_at?: string;
          sale_id: string;
        };
        Returns: Database["public"]["CompositeTypes"]["sale_result"];
        SetofOptions: {
          from: "*";
          to: "sale_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_sale_refund: {
        Args: { amount: unknown; reason: string; refund_id: string; sale_id: string };
        Returns: {
          amount: number;
          created_at: string;
          currency: string;
          id: string;
          integration_event_id: string | null;
          reason: string;
          recorded_by: string | null;
          restocked: boolean;
          sale_id: string;
          shopify_refund_id: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "sale_refunds";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_settlement: {
        Args: {
          allocations: Json;
          amount: unknown;
          consignor_id: string;
          notes?: string;
          paid_at?: string;
          reference?: string;
          settlement_id: string;
        };
        Returns: Database["public"]["CompositeTypes"]["settlement_result"];
        SetofOptions: {
          from: "*";
          to: "settlement_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_shopify_webhook: {
        Args: {
          api_version: string;
          body_bytes: number;
          body_sha256: string;
          correlation_id: string;
          headers: Json;
          hmac_valid: boolean;
          payload: Json;
          rejection_reason: Database["public"]["Enums"]["integration_rejection_reason"];
          shop_domain: string;
          shopify_event_id: string;
          topic: string;
          triggered_at: string;
          webhook_id: string;
        };
        Returns: {
          duplicate: boolean;
          event_id: string;
          event_status: Database["public"]["Enums"]["integration_event_status"];
          job_id: string;
        }[];
      };
      record_stripe_event: {
        Args: {
          body_bytes: number;
          body_sha256: string;
          correlation_id: string;
          headers: Json;
          payload: Json;
          rejection_reason: Database["public"]["Enums"]["stripe_rejection_reason"];
        };
        Returns: {
          duplicate: boolean;
          event_id: string;
          event_status: Database["public"]["Enums"]["stripe_event_status"];
          outcome: string;
          payment_id: string;
        }[];
      };
      record_stripe_read: {
        Args: { correlation_id: string; object: Json; payment_id: string };
        Returns: {
          event_id: string;
          event_status: Database["public"]["Enums"]["stripe_event_status"];
          outcome: string;
          payment_status: Database["public"]["Enums"]["payment_status"];
        }[];
      };
      remove_purchase_order_line: {
        Args: { line_id: string; reason?: string };
        Returns: {
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          ordered_total: number | null;
          product_id: string;
          purchase_order_id: string;
          quantity_ordered: number;
          unit_cost: number;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "purchase_order_lines";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      remove_supplier_product: {
        Args: { product_id: string; supplier_id: string };
        Returns: {
          created_at: string;
          currency: string;
          last_received_at: string | null;
          last_unit_cost: number | null;
          lead_days: number | null;
          preferred: boolean;
          product_id: string;
          supplier_id: string;
          supplier_sku: string | null;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "supplier_products";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      reorder_suggestions: {
        Args: { supplier_id?: string };
        Returns: {
          draft_po_numbers: string[];
          name: string;
          on_hand: number;
          on_order: number;
          preferred_supplier_id: string;
          product_id: string;
          reorder_point: number;
          short_id: string;
          sku: string;
          suggested_quantity: number;
          supplier_linked: boolean;
          supplier_sku: string;
        }[];
      };
      report_activity: {
        Args: { p_from: string; p_to: string };
        Returns: {
          appointments_arrived: number;
          appointments_cancelled: number;
          appointments_no_show: number;
          appointments_scheduled: number;
          jobs_cancelled: number;
          jobs_checked_in: number;
          jobs_collected: number;
          jobs_completed: number;
          jobs_open_at_end: number;
          jobs_ready_for_collection: number;
          jobs_started: number;
          median_hours_to_collect: number;
          median_hours_to_complete: number;
          parts_consumed_lines: number;
          parts_consumed_qty: number;
          parts_returned_qty: number;
          purchase_receipts: number;
          purchase_units_received: number;
          significant_stock_adjustments: number;
          stock_adjustments: number;
        }[];
      };
      report_activity_by_mechanic: {
        Args: { p_from: string; p_to: string };
        Returns: {
          active: boolean;
          display_name: string;
          jobs_checked_in: number;
          jobs_collected: number;
          jobs_completed: number;
          jobs_open_now: number;
          staff_id: string;
        }[];
      };
      report_breakdown: {
        Args: {
          p_after_key?: string;
          p_after_sale_total?: number;
          p_basis?: Database["public"]["Enums"]["report_date_basis"];
          p_dimension?: Database["public"]["Enums"]["report_dimension"];
          p_from: string;
          p_key?: string;
          p_max_rows?: number;
          p_to: string;
        };
        Returns: {
          cost_total: number;
          cult_commons_share: number;
          detail: string;
          entity_id: string;
          entity_type: string;
          first_at: string;
          job_count: number;
          key: string;
          label: string;
          last_at: string;
          line_count: number;
          quantity: number;
          sale_count: number;
          sale_total: number;
          yield_after_cc: number;
          yield_total: number;
        }[];
      };
      report_exception_counts: {
        Args: Record<PropertyKey, never>;
        Returns: {
          count: number;
          kind: string;
          severity: string;
        }[];
      };
      report_line_items: {
        Args: {
          p_after_at?: string;
          p_after_id?: string;
          p_basis?: Database["public"]["Enums"]["report_date_basis"];
          p_dimension?: Database["public"]["Enums"]["report_dimension"];
          p_from: string;
          p_key?: string;
          p_max_rows?: number;
          p_to: string;
        };
        Returns: {
          basis_at: string;
          category_name: string;
          channel: string;
          cost_pending: boolean;
          cost_total: number;
          cult_commons_share: number;
          currency: string;
          description: string;
          document_id: string;
          document_number: string;
          line_type: string;
          mechanic_name: string;
          ownership_type: string;
          quantity: number;
          sale_total: number;
          source: string;
          source_line_id: string;
          unit_sale_price: number;
          yield_total: number;
        }[];
      };
      report_period_series: {
        Args: {
          p_basis?: Database["public"]["Enums"]["report_date_basis"];
          p_from: string;
          p_grain?: Database["public"]["Enums"]["report_grain"];
          p_to: string;
        };
        Returns: {
          bucket_end: string;
          bucket_start: string;
          consignment_sales: number;
          consignment_sales_total: number;
          cost_total: number;
          cult_commons_share: number;
          job_count: number;
          line_count: number;
          loss_line_count: number;
          new_consignor_liability: number;
          partial: boolean;
          refunds_total: number;
          sale_count: number;
          sale_total: number;
          settlements_paid_total: number;
          yield_after_cc: number;
          yield_total: number;
        }[];
      };
      report_period_summary: {
        Args: {
          p_basis?: Database["public"]["Enums"]["report_date_basis"];
          p_from: string;
          p_to: string;
        };
        Returns: {
          basis: Database["public"]["Enums"]["report_date_basis"];
          consignment_sales: number;
          consignment_sales_total: number;
          cost_pending_lines: number;
          cost_total: number;
          cult_commons_share: number;
          currency: string;
          excluded_foreign_line_count: number;
          from_date: string;
          job_count: number;
          line_count: number;
          loss_line_count: number;
          new_consignor_liability: number;
          purchases_received_total: number;
          refund_count: number;
          refunds_total: number;
          sale_count: number;
          sale_total: number;
          settlements_paid_total: number;
          to_date: string;
          yield_after_cc: number;
          yield_total: number;
        }[];
      };
      report_stock_reconciliation: {
        Args: { p_max_rows?: number; p_only_issues?: boolean; p_product_id?: string };
        Returns: {
          issue: string;
          ledger_on_hand: number;
          location_id: string;
          location_name: string;
          product_id: string;
          product_name: string;
          product_short_id: string;
          tracking_type: Database["public"]["Enums"]["tracking_type"];
          units_in_stock: number;
        }[];
      };
      report_stock_value: {
        Args: Record<PropertyKey, never>;
        Returns: {
          currency: string;
          ownership_type: string;
          quantity_on_hand: number;
          uncosted_items: number;
          units_in_stock: number;
          value_at_cost: number;
        }[];
      };
      report_unit_reconciliation: {
        Args: { p_max_rows?: number; p_only_issues?: boolean; p_product_id?: string };
        Returns: {
          disposition: string;
          disposition_ref: string;
          expected_on_hand: number;
          issue: string;
          issue_detail: string;
          last_movement_at: string;
          ledger_location_id: string;
          ledger_location_name: string;
          ledger_on_hand: number;
          location_id: string;
          location_name: string;
          product_id: string;
          product_name: string;
          status: Database["public"]["Enums"]["unit_status"];
          unit_id: string;
          unit_short_id: string;
        }[];
      };
      request_product_sync: { Args: { product_id: string }; Returns: string };
      restock_unit: {
        Args: { location_id?: string; reason?: string; sale_line_id: string; unit_id: string };
        Returns: Database["public"]["CompositeTypes"]["unit_status_result"];
        SetofOptions: {
          from: "*";
          to: "unit_status_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      retry_integration_job: {
        Args: { job_id: string };
        Returns: {
          attempts: number;
          created_at: string;
          id: string;
          integration_event_id: string | null;
          kind: Database["public"]["Enums"]["integration_job_kind"];
          last_error: string | null;
          last_error_code: string | null;
          last_retried_at: string | null;
          last_retried_by: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          product_id: string | null;
          resolution_reason: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: Database["public"]["Enums"]["integration_job_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "integration_retry_queue";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      return_consignment_item: {
        Args: {
          item_id: string;
          location_id?: string;
          quantity?: number;
          reason: string;
          return_id: string;
        };
        Returns: Database["public"]["CompositeTypes"]["consignment_item_result"];
        SetofOptions: {
          from: "*";
          to: "consignment_item_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reverse_settlement: {
        Args: { reason: string; reversal_id: string; settlement_id: string };
        Returns: {
          created_at: string;
          created_by: string | null;
          id: string;
          reason: string;
          settlement_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "consignment_settlement_reversals";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      revoke_permission: {
        Args: {
          permission: Database["public"]["Enums"]["permission_key"];
          target_staff_id: string;
        };
        Returns: {
          granted_at: string;
          granted_by: string | null;
          permission: Database["public"]["Enums"]["permission_key"];
          staff_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "staff_permissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      sale_lines_detail: {
        Args: { sale_id: string };
        Returns: {
          bike_id: string;
          bike_short_id: string;
          consignment_item_id: string;
          consignment_short_id: string;
          consignor_id: string;
          consignor_name: string;
          consignor_payout_snapshot: number;
          cost_total: number;
          cult_commons_rate_snapshot: number;
          cult_commons_share: number;
          description_snapshot: string;
          id: string;
          inventory_unit_id: string;
          line_number: number;
          product_id: string;
          product_short_id: string;
          quantity: number;
          restocked_at: string;
          restocked_by_name: string;
          sale_total: number;
          unit_direct_cost_snapshot: number;
          unit_ownership_type: Database["public"]["Enums"]["ownership_type"];
          unit_sale_price_snapshot: number;
          unit_short_id: string;
          unit_sold_sale_line_id: string;
          unit_status: Database["public"]["Enums"]["unit_status"];
          yield_total: number;
        }[];
      };
      saleable_stock: {
        Args: { max_results?: number; q: string };
        Returns: {
          consignment_item_id: string;
          consignment_short_id: string;
          consignor_name: string;
          inventory_unit_id: string;
          kind: string;
          location_id: string;
          location_name: string;
          on_hand: number;
          ownership_type: Database["public"]["Enums"]["ownership_type"];
          product_id: string;
          product_short_id: string;
          rank: number;
          subtitle: string;
          title: string;
          unit_price: number;
          unit_short_id: string;
        }[];
      };
      save_appointment_type: {
        Args: {
          active: boolean;
          appointment_type_id: string;
          capacity_units: number;
          description: string;
          duration_minutes: number;
          is_new: boolean;
          name: string;
          public: boolean;
          sort_order?: number;
        };
        Returns: {
          active: boolean;
          capacity_units: number;
          created_at: string;
          description: string | null;
          duration_minutes: number;
          id: string;
          name: string;
          public: boolean;
          sort_order: number;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "appointment_types";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      save_closure_override: {
        Args: {
          closure_id: string;
          first_day: string;
          from_time?: string;
          is_new: boolean;
          kind: Database["public"]["Enums"]["closure_kind"];
          last_day: string;
          reason: string;
          to_time?: string;
        };
        Returns: {
          closes_at: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          id: string;
          kind: Database["public"]["Enums"]["closure_kind"];
          opens_at: string | null;
          reason: string;
          starts_at: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "closure_overrides";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      schedule_cult_commons_rate: {
        Args: { effective_from?: string; rate: unknown; rate_id: string };
        Returns: {
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          effective_from: string;
          id: string;
          rate: number;
        };
        SetofOptions: {
          from: "*";
          to: "cult_commons_rates";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      send_quote: {
        Args: {
          channel: Database["public"]["Enums"]["quote_channel"];
          quote_id: string;
          request_ids: string[];
          valid_days?: number;
          work_order_id: string;
        };
        Returns: string;
      };
      set_approval_flag: {
        Args: { flagged: boolean; note?: string; work_order_id: string };
        Returns: {
          appointment_id: string | null;
          approval_flag: boolean;
          approval_note: string | null;
          bike_id: string;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          checked_in_at: string;
          collected_at: string | null;
          completed_at: string | null;
          completion_notes: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          customer_id: string;
          id: string;
          intake_notes: string | null;
          internal_notes: string | null;
          job_number: string;
          lead_mechanic_id: string | null;
          ready_for_collection_at: string | null;
          requested_work: string;
          started_at: string | null;
          status: Database["public"]["Enums"]["work_order_status"];
          status_changed_at: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "work_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_attachment_visibility: {
        Args: {
          attachment_id: string;
          new_bucket?: string;
          new_path?: string;
          visibility: Database["public"]["Enums"]["attachment_visibility"];
        };
        Returns: {
          byte_size: number | null;
          caption: string | null;
          created_at: string;
          created_by: string | null;
          entity_id: string;
          entity_type: Database["public"]["Enums"]["attachment_entity"];
          height: number | null;
          id: string;
          media_type: string;
          storage_bucket: string;
          storage_path: string;
          updated_at: string;
          visibility: Database["public"]["Enums"]["attachment_visibility"];
          width: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "attachments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_consignment_settlement_alert_days: { Args: { p_days: number }; Returns: number };
      set_default_label_template: {
        Args: { template_id: string };
        Returns: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          height_mm: number;
          id: string;
          is_default: boolean;
          kind: Database["public"]["Enums"]["label_kind"];
          layout: NonNullable<Json>;
          name: string;
          updated_at: string;
          width_mm: number;
        };
        SetofOptions: {
          from: "*";
          to: "label_templates";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_default_printer_profile: {
        Args: { profile_id: string };
        Returns: {
          active: boolean;
          adapter: Database["public"]["Enums"]["printer_adapter"];
          config: NonNullable<Json>;
          created_at: string;
          created_by: string | null;
          id: string;
          is_default: boolean;
          name: string;
          sort_order: number;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "printer_profiles";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_print_job_status: {
        Args: {
          error?: string;
          job_id: string;
          status: Database["public"]["Enums"]["print_status"];
        };
        Returns: {
          adapter: Database["public"]["Enums"]["printer_adapter"];
          bike_id: string | null;
          completed_at: string | null;
          content: NonNullable<Json>;
          correlation_id: string | null;
          created_at: string;
          error: string | null;
          id: string;
          inventory_unit_id: string | null;
          label_kind: Database["public"]["Enums"]["label_kind"];
          label_template_id: string;
          printer_profile_id: string;
          product_id: string | null;
          profile_snapshot: NonNullable<Json>;
          qr_payload: string;
          quantity: number;
          rendered_at: string | null;
          reprint_of_id: string | null;
          requested_by: string;
          short_id: string;
          status: Database["public"]["Enums"]["print_status"];
          status_changed_by: string | null;
          template_snapshot: NonNullable<Json>;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "print_jobs";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_publication_status: {
        Args: {
          product_id: string;
          reason?: string;
          status: Database["public"]["Enums"]["publication_status"];
        };
        Returns: Database["public"]["CompositeTypes"]["publication_result"];
        SetofOptions: {
          from: "*";
          to: "publication_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_publish_online: {
        Args: { product_id: string; publish: boolean };
        Returns: Database["public"]["CompositeTypes"]["shopify_publish_result"];
        SetofOptions: {
          from: "*";
          to: "shopify_publish_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_purchase_order_line: {
        Args: {
          expected_at?: string;
          id: string;
          notes?: string;
          product_id: string;
          purchase_order_id: string;
          quantity_ordered: number;
          reason?: string;
          unit_cost: unknown;
        };
        Returns: {
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          ordered_total: number | null;
          product_id: string;
          purchase_order_id: string;
          quantity_ordered: number;
          unit_cost: number;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "purchase_order_lines";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_service_archived: { Args: { archived: boolean; service_id: string }; Returns: string };
      set_shop_hours: {
        Args: { active?: boolean; intervals: Json; weekday: number };
        Returns: {
          active: boolean;
          closes_at: string;
          created_at: string;
          id: string;
          opens_at: string;
          updated_at: string;
          weekday: number;
        }[];
        SetofOptions: {
          from: "*";
          to: "shop_hours";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      set_shopify_settings: {
        Args: {
          accept_test_orders: boolean;
          online_location_id: string;
          reason: string;
          storefront_url: string;
        };
        Returns: {
          accept_test_orders: boolean;
          id: number;
          online_location_id: string;
          shopify_location_id: string | null;
          storefront_url: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "shopify_settings";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_staff_active: {
        Args: { active: boolean; reason?: string; target_staff_id: string };
        Returns: {
          active: boolean;
          auth_user_id: string;
          created_at: string;
          display_name: string;
          email: string;
          id: string;
          role: Database["public"]["Enums"]["staff_role"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "staff";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_supplier_product: {
        Args: {
          lead_days?: number;
          preferred?: boolean;
          product_id: string;
          supplier_id: string;
          supplier_sku?: string;
        };
        Returns: {
          created_at: string;
          currency: string;
          last_received_at: string | null;
          last_unit_cost: number | null;
          lead_days: number | null;
          preferred: boolean;
          product_id: string;
          supplier_id: string;
          supplier_sku: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "supplier_products";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_work_order_status: {
        Args: {
          note?: string;
          status: Database["public"]["Enums"]["work_order_status"];
          work_order_id: string;
        };
        Returns: {
          appointment_id: string | null;
          approval_flag: boolean;
          approval_note: string | null;
          bike_id: string;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          checked_in_at: string;
          collected_at: string | null;
          completed_at: string | null;
          completion_notes: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          customer_id: string;
          id: string;
          intake_notes: string | null;
          internal_notes: string | null;
          job_number: string;
          lead_mechanic_id: string | null;
          ready_for_collection_at: string | null;
          requested_work: string;
          started_at: string | null;
          status: Database["public"]["Enums"]["work_order_status"];
          status_changed_at: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "work_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      split_unit_from_stock: {
        Args: {
          condition?: string;
          location_id: string;
          name: string;
          new_product_id: string;
          reason: string;
          sale_price?: unknown;
          serial_number?: string;
          source_product_id: string;
          unit_id: string;
        };
        Returns: Database["public"]["CompositeTypes"]["split_unit_result"];
        SetofOptions: {
          from: "*";
          to: "split_unit_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      staff_directory: {
        Args: Record<PropertyKey, never>;
        Returns: {
          active: boolean;
          display_name: string;
          id: string;
          role: Database["public"]["Enums"]["staff_role"];
        }[];
      };
      staff_history: {
        Args: { max_rows?: number; target_staff_id: string };
        Returns: {
          actor_display_name: string;
          actor_staff_id: string;
          correlation_id: string;
          created_at: string;
          event_type: Database["public"]["Enums"]["staff_event_type"];
          id: string;
          payload: Json;
          permission: Database["public"]["Enums"]["permission_key"];
          reason: string;
        }[];
      };
      staff_roster: {
        Args: Record<PropertyKey, never>;
        Returns: {
          active: boolean;
          auth_user_id: string;
          created_at: string;
          display_name: string;
          email: string;
          granted_permissions: Database["public"]["Enums"]["permission_key"][];
          id: string;
          role: Database["public"]["Enums"]["staff_role"];
        }[];
      };
      staff_search: {
        Args: { archived?: boolean; kinds?: string[]; max_results?: number; q: string };
        Returns: {
          id: string;
          kind: string;
          rank: number;
          short_id: string;
          subtitle: string;
          title: string;
        }[];
      };
      stock_adjustments_on: {
        Args: { on_day?: string };
        Returns: {
          actor_name: string;
          created_at: string;
          currency: string;
          inventory_unit_id: string;
          location_name: string;
          movement_id: number;
          movement_type: string;
          product_id: string;
          product_name: string;
          product_short_id: string;
          quantity_delta: number;
          reason: string;
          significant: boolean;
          unit_short_id: string;
          value_at_cost: number;
        }[];
      };
      submit_purchase_order: {
        Args: { purchase_order_id: string };
        Returns: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          po_number: string;
          received_at: string | null;
          status: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          supplier_id: string;
          supplier_reference: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "purchase_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      today_dashboard: {
        Args: { on_day?: string };
        Returns: {
          appointments_arrived: number;
          appointments_no_show: number;
          appointments_scheduled: number;
          awaiting_collection_now: number;
          bicii_yield_after_cc: number;
          can_see_costs: boolean;
          can_see_financials: boolean;
          cogs: number;
          consignment_sales: number;
          consignment_sales_total: number;
          cost_pending_lines: number;
          cult_commons_share: number;
          currency: string;
          day: string;
          exceptions_now: number;
          generated_at: string;
          gross_sales: number;
          in_progress_now: number;
          is_today: boolean;
          jobs_cancelled: number;
          jobs_checked_in: number;
          jobs_collected: number;
          jobs_completed: number;
          jobs_ready_for_collection: number;
          jobs_started: number;
          lines_recognised: number;
          loss_lines: number;
          loss_total: number;
          low_stock_now: number;
          new_consignor_liability: number;
          open_jobs_now: number;
          overdue_now: number;
          parts_consumed_lines: number;
          parts_consumed_qty: number;
          parts_returned_qty: number;
          ready_to_start_now: number;
          received_now: number;
          significant_stock_adjustments: number;
          stock_adjustments: number;
          waiting_now: number;
          yield_total: number;
        }[];
      };
      transfer_bike_ownership: {
        Args: { bike_id: string; reason: string; to_customer_id: string };
        Returns: {
          archived_at: string | null;
          brand: string;
          colour: string | null;
          created_at: string;
          customer_id: string | null;
          description: string | null;
          frame_size: string | null;
          id: string;
          internal_notes: string | null;
          inventory_unit_id: string | null;
          model: string;
          search_text: string | null;
          serial_key: string | null;
          serial_number: string | null;
          short_id: string;
          updated_at: string;
          variant: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "bikes";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      transfer_stock: {
        Args: {
          from_location_id: string;
          inventory_unit_id?: string;
          product_id: string;
          quantity: number;
          reason?: string;
          request_id: string;
          to_location_id: string;
        };
        Returns: {
          location_id: string;
          movement_id: number;
          quantity_delta: number;
        }[];
      };
      unassign_staff: {
        Args: { staff_id: string; work_order_id: string };
        Returns: {
          assigned_at: string;
          assigned_by: string | null;
          id: string;
          role: Database["public"]["Enums"]["assignment_role"];
          staff_id: string;
          unassigned_at: string | null;
          unassigned_by: string | null;
          work_order_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "work_order_assignments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_appointment: {
        Args: {
          appointment_id: string;
          bike_id?: string;
          clear_bike?: boolean;
          customer_note?: string;
          internal_note?: string;
        };
        Returns: {
          appointment_type_id: string;
          arrived_at: string | null;
          bike_id: string | null;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_via: Database["public"]["Enums"]["appointment_source"] | null;
          capacity_units: number;
          checked_in_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          created_by_staff_id: string | null;
          created_by_user_id: string | null;
          customer_id: string;
          customer_note: string | null;
          ends_at: string;
          id: string;
          internal_note: string | null;
          no_show_at: string | null;
          source: Database["public"]["Enums"]["appointment_source"];
          starts_at: string;
          status: Database["public"]["Enums"]["appointment_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "appointments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_consignment_terms: {
        Args: {
          agreed_amount_owed?: unknown;
          asking_price?: unknown;
          item_id: string;
          reason?: string;
        };
        Returns: Database["public"]["CompositeTypes"]["consignment_item_result"];
        SetofOptions: {
          from: "*";
          to: "consignment_item_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_my_profile: {
        Args: { display_name?: string; first_name?: string; last_name?: string; phone?: string };
        Returns: Database["public"]["CompositeTypes"]["customer_profile"];
        SetofOptions: {
          from: "*";
          to: "customer_profile";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_purchase_order: {
        Args: {
          expected_at: string;
          notes: string;
          purchase_order_id: string;
          supplier_id: string;
          supplier_reference: string;
        };
        Returns: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          expected_at: string | null;
          id: string;
          notes: string | null;
          po_number: string;
          received_at: string | null;
          status: Database["public"]["Enums"]["purchase_order_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          supplier_id: string;
          supplier_reference: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "purchase_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_service: {
        Args: {
          category_id?: string;
          default_direct_cost?: unknown;
          default_sale_price: unknown;
          description?: string;
          is_active?: boolean;
          is_public?: boolean;
          name: string;
          service_id: string;
        };
        Returns: string;
      };
      update_shop_settings: {
        Args: {
          booking_horizon_days?: number;
          booking_min_notice_minutes?: number;
          customer_cancel_cutoff_minutes?: number;
          customer_max_active_bookings?: number;
          intake_capacity_units?: number;
          intake_slot_minutes?: number;
          public_site_url?: string;
        };
        Returns: {
          booking_horizon_days: number;
          booking_min_notice_minutes: number;
          consignment_settlement_alert_days: number;
          customer_cancel_cutoff_minutes: number;
          customer_max_active_bookings: number;
          default_currency: string;
          id: number;
          intake_capacity_units: number;
          intake_slot_minutes: number;
          public_site_url: string | null;
          timezone: string;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "shop_settings";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_staff: {
        Args: {
          display_name?: string;
          expected_role?: Database["public"]["Enums"]["staff_role"];
          reason?: string;
          role?: Database["public"]["Enums"]["staff_role"];
          target_staff_id: string;
        };
        Returns: {
          active: boolean;
          auth_user_id: string;
          created_at: string;
          display_name: string;
          email: string;
          id: string;
          role: Database["public"]["Enums"]["staff_role"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "staff";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_work_order: {
        Args: {
          completion_notes?: string;
          intake_notes?: string;
          internal_notes?: string;
          requested_work?: string;
          work_order_id: string;
        };
        Returns: {
          appointment_id: string | null;
          approval_flag: boolean;
          approval_note: string | null;
          bike_id: string;
          cancellation_reason: string | null;
          cancelled_at: string | null;
          checked_in_at: string;
          collected_at: string | null;
          completed_at: string | null;
          completion_notes: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          customer_id: string;
          id: string;
          intake_notes: string | null;
          internal_notes: string | null;
          job_number: string;
          lead_mechanic_id: string | null;
          ready_for_collection_at: string | null;
          requested_work: string;
          started_at: string | null;
          status: Database["public"]["Enums"]["work_order_status"];
          status_changed_at: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "work_orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      void_consignment_charge: {
        Args: { charge_id: string; reason: string };
        Returns: {
          amount: number;
          bearer: Database["public"]["Enums"]["charge_bearer"];
          consignment_item_id: string;
          created_at: string;
          created_by: string | null;
          currency: string;
          description: string;
          id: string;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
          work_order_id: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "consignment_item_charges";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      void_line: { Args: { line_id: string; reason: string }; Returns: string };
      withdraw_quote: { Args: { quote_id: string }; Returns: string };
      work_order_activity_on: {
        Args: { on_day?: string };
        Returns: {
          age_days: number;
          bike_id: string;
          bike_title: string;
          cancelled_at: string;
          cancelled_on_day: boolean;
          checked_in_at: string;
          checked_in_on_day: boolean;
          collected_at: string;
          collected_on_day: boolean;
          completed_at: string;
          completed_on_day: boolean;
          currency: string;
          customer_id: string;
          customer_label: string;
          is_open: boolean;
          is_overdue: boolean;
          job_number: string;
          lead_mechanic_name: string;
          ready_for_collection_at: string;
          ready_on_day: boolean;
          sale_total: number;
          started_at: string;
          started_on_day: boolean;
          status: Database["public"]["Enums"]["work_order_status"];
          work_order_id: string;
        }[];
      };
      work_order_timeline: {
        Args: { max_rows?: number; work_order_id: string };
        Returns: {
          actor_display_name: string;
          actor_staff_id: string;
          created_at: string;
          event_type: Database["public"]["Enums"]["work_order_event_type"];
          id: number;
          payload: Json;
          subject_display_name: string;
          subject_staff_id: string;
        }[];
      };
      work_order_yield: {
        Args: { target_work_order_id: string };
        Returns: {
          bicii_yield_after_cc: number;
          cost_pending_count: number;
          cost_total: number;
          cult_commons_rates: number[];
          cult_commons_share: number;
          currency: string;
          job_number: string;
          line_count: number;
          loss_line_count: number;
          loss_total: number;
          recognized_at: string;
          recognized_day: string;
          sale_total: number;
          status: Database["public"]["Enums"]["work_order_status"];
          work_order_id: string;
          yield_total: number;
        }[];
      };
      write_off_unit: {
        Args: { reason: string; request_id: string; unit_id: string };
        Returns: Database["public"]["CompositeTypes"]["unit_status_result"];
        SetofOptions: {
          from: "*";
          to: "unit_status_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
    };
    Enums: {
      appointment_event_type:
        | "booked"
        | "confirmed"
        | "arrived"
        | "checked_in"
        | "completed"
        | "cancelled"
        | "no_show"
        | "details_changed"
        | "work_order_linked";
      appointment_source: "staff" | "customer";
      appointment_status:
        "booked" | "confirmed" | "arrived" | "checked_in" | "completed" | "cancelled" | "no_show";
      assignment_role: "lead" | "additional";
      attachment_entity:
        "bike" | "work_order" | "product" | "inventory_unit" | "customer" | "consignment_item";
      attachment_event_type: "created" | "visibility_changed" | "caption_changed" | "deleted";
      attachment_visibility: "internal" | "customer" | "public";
      bike_ownership_event_type: "registered" | "transferred";
      category_kind: "service" | "product";
      charge_bearer: "consignor" | "shop";
      closure_kind: "closed" | "custom_hours";
      consignment_item_event_type:
        | "received"
        | "terms_changed"
        | "charge_added"
        | "charge_voided"
        | "status_changed"
        | "stock_returned";
      consignment_status: "active" | "sold" | "returned" | "withdrawn";
      customer_job_status:
        | "received"
        | "awaiting_customer"
        | "awaiting_parts"
        | "in_progress"
        | "completed"
        | "ready_for_collection"
        | "collected";
      integration_audit_type:
        | "publish_online_changed"
        | "sync_requested"
        | "variant_linked"
        | "customer_linked"
        | "job_retried"
        | "job_dismissed"
        | "settings_changed";
      integration_event_status: "pending" | "processed" | "skipped" | "failed" | "rejected";
      integration_job_kind: "shopify_event" | "product_sync";
      integration_job_status: "queued" | "running" | "done" | "needs_attention" | "dismissed";
      integration_rejection_reason:
        | "hmac_invalid"
        | "webhook_secret_missing"
        | "shop_not_configured"
        | "shop_domain_mismatch"
        | "missing_headers"
        | "body_not_json";
      inventory_unit_event_type:
        | "created"
        | "status_changed"
        | "moved"
        | "details_changed"
        | "price_changed"
        | "cost_changed"
        | "archived"
        | "unarchived";
      label_kind: "product" | "unit" | "bike";
      line_type: "service" | "inventory" | "manual";
      location_kind: "shop_floor" | "workshop" | "storage" | "offsite";
      movement_type:
        | "purchase_received"
        | "job_consumption"
        | "retail_sale"
        | "online_sale"
        | "stock_adjustment"
        | "damaged"
        | "return"
        | "consignment_received"
        | "consignment_returned"
        | "transfer"
        | "reversal";
      ownership_type: "shop_owned" | "consignment" | "customer_owned";
      part_request_kind: "part" | "service";
      part_request_status:
        "proposed" | "quoted" | "approved" | "declined" | "ordered" | "fitted" | "cancelled";
      payment_kind: "deposit" | "balance";
      payment_status: "pending" | "paid" | "failed" | "expired" | "partially_refunded" | "refunded";
      permission_key:
        | "view_costs"
        | "manage_inventory"
        | "adjust_stock"
        | "manage_consignments"
        | "manage_purchasing"
        | "manage_staff"
        | "view_financial_reports";
      print_status: "queued" | "rendered" | "printed" | "failed";
      printer_adapter: "browser" | "pdf" | "network_raw" | "bluetooth";
      product_event_type:
        | "created"
        | "details_changed"
        | "price_changed"
        | "cost_changed"
        | "publication_changed"
        | "archived"
        | "unarchived";
      publication_status: "draft" | "internal_only" | "public" | "sold" | "archived";
      purchase_order_event_type:
        | "created"
        | "details_changed"
        | "line_added"
        | "line_changed"
        | "line_removed"
        | "submitted"
        | "received"
        | "status_changed"
        | "cancelled";
      purchase_order_status:
        "draft" | "submitted" | "partially_received" | "received" | "cancelled";
      quote_channel: "whatsapp" | "email" | "link";
      quote_status: "open" | "answered" | "withdrawn";
      report_date_basis: "sale" | "check_in" | "completion" | "collection";
      report_dimension:
        "job" | "product" | "category" | "service" | "mechanic" | "ownership" | "channel";
      report_grain: "day" | "week" | "month";
      sale_source: "retail" | "online_shopify" | "work_order";
      sale_status: "recorded" | "partially_refunded" | "refunded" | "voided";
      schedule_entity: "shop_settings" | "shop_hours" | "closure_override" | "appointment_type";
      schedule_event_type: "created" | "updated" | "deleted";
      shopify_sync_status: "not_synced" | "pending" | "synced" | "error" | "unpublished";
      staff_event_type:
        | "created"
        | "details_changed"
        | "role_changed"
        | "deactivated"
        | "reactivated"
        | "permission_granted"
        | "permission_revoked";
      staff_role: "admin" | "manager" | "mechanic";
      stripe_event_source: "webhook" | "api_read";
      stripe_event_status: "received" | "applied" | "ignored" | "needs_attention" | "rejected";
      stripe_refund_status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
      stripe_rejection_reason:
        | "stripe_off"
        | "signature_invalid"
        | "signature_expired"
        | "body_not_json"
        | "event_shape_invalid"
        | "livemode_mismatch"
        | "not_recorded";
      tracking_type: "quantity" | "unique";
      unit_status:
        | "available"
        | "reserved"
        | "sold"
        | "returned_to_consignor"
        | "written_off"
        | "held_for_customer";
      work_order_event_type:
        | "checked_in"
        | "status_changed"
        | "completed"
        | "ready_for_collection"
        | "collected"
        | "cancelled"
        | "reopened"
        | "assignment_changed"
        | "note_added"
        | "diagnosis_added"
        | "details_changed"
        | "approval_flagged"
        | "photo_added"
        | "photo_removed"
        | "line_added"
        | "line_voided"
        | "stock_consumed"
        | "stock_reversed"
        | "appointment_linked"
        | "part_requested"
        | "part_request_cancelled"
        | "quote_sent"
        | "quote_withdrawn"
        | "quote_answered"
        | "part_ordered"
        | "part_fitted"
        | "payment_received"
        | "payment_refunded"
        | "payment_refund_failed";
      work_order_note_kind: "note" | "diagnosis";
      work_order_status:
        | "received"
        | "diagnosing"
        | "awaiting_customer"
        | "awaiting_parts"
        | "ready_to_start"
        | "in_progress"
        | "paused"
        | "completed"
        | "ready_for_collection"
        | "collected"
        | "cancelled";
    };
    CompositeTypes: {
      appointment_check_in: {
        appointment_id: string | null;
        appointment_status: Database["public"]["Enums"]["appointment_status"] | null;
        work_order_id: string | null;
        job_number: string | null;
        created: boolean | null;
      };
      consignment_item_result: {
        item_id: string | null;
        short_id: string | null;
        status: Database["public"]["Enums"]["consignment_status"] | null;
        product_id: string | null;
        inventory_unit_id: string | null;
      };
      customer_profile: {
        id: string | null;
        first_name: string | null;
        last_name: string | null;
        display_name: string | null;
        email: string | null;
        phone: string | null;
        created_at: string | null;
      };
      inventory_line_result: {
        line_id: string | null;
        movement_id: number | null;
        location_id: string | null;
        on_hand_after: number | null;
        replayed: boolean | null;
      };
      my_appointment: {
        id: string | null;
        appointment_type_id: string | null;
        appointment_type_name: string | null;
        starts_at: string | null;
        ends_at: string | null;
        status: Database["public"]["Enums"]["appointment_status"] | null;
        bike_id: string | null;
        bike_short_id: string | null;
        bike_title: string | null;
        customer_note: string | null;
        cancelled_at: string | null;
        cancelled_via: Database["public"]["Enums"]["appointment_source"] | null;
        created_at: string | null;
        can_cancel: boolean | null;
      };
      publication_result: {
        product_id: string | null;
        publication_status: Database["public"]["Enums"]["publication_status"] | null;
        public_slug: string | null;
      };
      sale_result: {
        sale_id: string | null;
        sale_number: string | null;
        status: Database["public"]["Enums"]["sale_status"] | null;
        recognized_at: string | null;
        replayed: boolean | null;
      };
      settlement_result: {
        settlement_id: string | null;
        consignor_id: string | null;
        amount: number | null;
        paid_at: string | null;
        replayed: boolean | null;
      };
      shopify_customer_link_result: {
        customer_id: string | null;
        shopify_customer_id: string | null;
        earlier_online_sales: number | null;
      };
      shopify_product_sync_state: {
        product_id: string | null;
        short_id: string | null;
        sku: string | null;
        name: string | null;
        description: string | null;
        brand: string | null;
        tracking_type: Database["public"]["Enums"]["tracking_type"] | null;
        ownership_type: Database["public"]["Enums"]["ownership_type"] | null;
        publication_status: Database["public"]["Enums"]["publication_status"] | null;
        active: boolean | null;
        archived: boolean | null;
        sale_price: unknown;
        currency: string | null;
        publish_online: boolean | null;
        effective_online: boolean | null;
        available_quantity: number | null;
        unit_price_conflicts: string[] | null;
        public_photo_paths: string[] | null;
        handle: string | null;
        shopify_origin: string | null;
        shopify_product_id: string | null;
        shopify_variant_id: string | null;
        shopify_inventory_item_id: string | null;
        shopify_location_id: string | null;
        online_location_name: string | null;
        last_desired_hash: string | null;
        last_pushed_quantity: number | null;
        orders_in_flight: boolean | null;
        sync_status: Database["public"]["Enums"]["shopify_sync_status"] | null;
      };
      shopify_publish_result: {
        product_id: string | null;
        publish_online: boolean | null;
        sync_status: Database["public"]["Enums"]["shopify_sync_status"] | null;
        job_id: string | null;
      };
      split_unit_result: {
        product_id: string | null;
        product_short_id: string | null;
        unit_id: string | null;
        unit_short_id: string | null;
      };
      unique_unit_result: {
        unit_id: string | null;
        short_id: string | null;
      };
      unit_status_result: {
        unit_id: string | null;
        status: Database["public"]["Enums"]["unit_status"] | null;
      };
    };
  };
  reporting: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      appointment_daily: {
        Row: {
          arrived: number | null;
          booked: number | null;
          cancelled: number | null;
          checked_in: number | null;
          day: string | null;
          expected: number | null;
          no_shows: number | null;
        };
        Relationships: [];
      };
      consignment_item_position: {
        Row: {
          consignment_item_id: string | null;
          consignor_charges: number | null;
          consignor_id: string | null;
          inventory_unit_id: string | null;
          job_held_qty: number | null;
          job_sold_qty: number | null;
          last_returned_at: string | null;
          last_sale_at: string | null;
          liability: number | null;
          owed_qty: number | null;
          product_id: string | null;
          quantity: number | null;
          remaining_qty: number | null;
          restocked_qty: number | null;
          returned_qty: number | null;
          shop_charges: number | null;
          sold_qty: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "consignment_items_consignor_id_fkey";
            columns: ["consignor_id"];
            isOneToOne: false;
            referencedRelation: "consignor_ledger";
            referencedColumns: ["consignor_id"];
          },
          {
            foreignKeyName: "consignment_items_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: true;
            referencedRelation: "unit_ledger_disposition";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "consignment_items_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: true;
            referencedRelation: "unit_reconciliation";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "consignment_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "low_stock";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "consignment_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_stock";
            referencedColumns: ["product_id"];
          },
        ];
      };
      consignor_item_ledger: {
        Row: {
          agreed_amount_owed: number | null;
          asking_price: number | null;
          consignment_item_id: string | null;
          consignor_charges: number | null;
          consignor_id: string | null;
          currency: string | null;
          inventory_unit_id: string | null;
          job_held_qty: number | null;
          job_sold_qty: number | null;
          last_returned_at: string | null;
          last_sale_at: string | null;
          last_settlement_at: string | null;
          liability: number | null;
          outstanding: number | null;
          owed: number | null;
          owed_qty: number | null;
          paid: number | null;
          product_id: string | null;
          quantity: number | null;
          received_at: string | null;
          remaining_qty: number | null;
          restocked_qty: number | null;
          return_reason: string | null;
          returned_at: string | null;
          returned_qty: number | null;
          shop_charges: number | null;
          short_id: string | null;
          sold_at: string | null;
          sold_qty: number | null;
          status: Database["public"]["Enums"]["consignment_status"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "consignment_items_consignor_id_fkey";
            columns: ["consignor_id"];
            isOneToOne: false;
            referencedRelation: "consignor_ledger";
            referencedColumns: ["consignor_id"];
          },
          {
            foreignKeyName: "consignment_items_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: true;
            referencedRelation: "unit_ledger_disposition";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "consignment_items_inventory_unit_id_fkey";
            columns: ["inventory_unit_id"];
            isOneToOne: true;
            referencedRelation: "unit_reconciliation";
            referencedColumns: ["unit_id"];
          },
          {
            foreignKeyName: "consignment_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "low_stock";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "consignment_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_stock";
            referencedColumns: ["product_id"];
          },
        ];
      };
      consignor_ledger: {
        Row: {
          active_items: number | null;
          archived_at: string | null;
          awaiting_settlement_items: number | null;
          consignor_charges: number | null;
          consignor_id: string | null;
          currency: string | null;
          customer_id: string | null;
          display_name: string | null;
          items_total: number | null;
          last_sale_at: string | null;
          last_settlement_at: string | null;
          liability: number | null;
          outstanding: number | null;
          owed: number | null;
          paid: number | null;
          returned_items: number | null;
          sold_items: number | null;
        };
        Relationships: [];
      };
      daily_summary: {
        Row: {
          appointments_arrived: number | null;
          appointments_no_show: number | null;
          appointments_scheduled: number | null;
          bicii_yield_after_cc: number | null;
          cogs: number | null;
          consignment_sales: number | null;
          consignment_sales_total: number | null;
          cult_commons_share: number | null;
          currency: string | null;
          day: string | null;
          gross_sales: number | null;
          jobs_cancelled: number | null;
          jobs_checked_in: number | null;
          jobs_collected: number | null;
          jobs_completed: number | null;
          jobs_ready_for_collection: number | null;
          jobs_started: number | null;
          lines_recognised: number | null;
          loss_lines: number | null;
          loss_total: number | null;
          new_consignor_liability: number | null;
          parts_consumed_lines: number | null;
          parts_consumed_qty: number | null;
          parts_returned_qty: number | null;
          significant_stock_adjustments: number | null;
          stock_adjustments: number | null;
          yield_total: number | null;
        };
        Relationships: [];
      };
      financial_lines: {
        Row: {
          bicii_yield_after_cc: number | null;
          bike_id: string | null;
          category_id: string | null;
          channel: string | null;
          consignment_item_id: string | null;
          cost_pending: boolean | null;
          cost_total: number | null;
          cult_commons_rate: number | null;
          cult_commons_share: number | null;
          currency: string | null;
          customer_id: string | null;
          description: string | null;
          document_id: string | null;
          document_number: string | null;
          entry_key: string | null;
          entry_kind: string | null;
          inventory_unit_id: string | null;
          is_loss: boolean | null;
          lead_mechanic_id: string | null;
          line_type: string | null;
          ownership_type: string | null;
          product_id: string | null;
          quantity: number | null;
          recognized_at: string | null;
          recognized_day: string | null;
          sale_total: number | null;
          service_id: string | null;
          source: string | null;
          source_line_id: string | null;
          unit_direct_cost: number | null;
          unit_sale_price: number | null;
          yield_total: number | null;
        };
        Relationships: [];
      };
      low_stock: {
        Row: {
          name: string | null;
          negative_locations: number | null;
          on_hand: number | null;
          product_id: string | null;
          reorder_point: number | null;
          short_id: string | null;
          shortfall: number | null;
          sku: string | null;
        };
        Relationships: [];
      };
      operational_exceptions: {
        Row: {
          amount: number | null;
          currency: string | null;
          days: number | null;
          detail: string | null;
          entity_id: string | null;
          entity_label: string | null;
          entity_type: string | null;
          issue: string | null;
          kind: string | null;
          quantity: number | null;
          severity: string | null;
          short_id: string | null;
          since: string | null;
          subject_label: string | null;
          title: string | null;
        };
        Relationships: [];
      };
      product_on_order: {
        Row: {
          next_expected_at: string | null;
          open_purchase_orders: number | null;
          product_id: string | null;
          quantity_on_order: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "low_stock";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_stock";
            referencedColumns: ["product_id"];
          },
        ];
      };
      product_stock: {
        Row: {
          active: boolean | null;
          archived_at: string | null;
          available_units: number | null;
          below_reorder: boolean | null;
          held_units: number | null;
          name: string | null;
          negative_locations: number | null;
          on_hand: number | null;
          product_id: string | null;
          reorder_point: number | null;
          short_id: string | null;
          sku: string | null;
          tracking_type: Database["public"]["Enums"]["tracking_type"] | null;
        };
        Relationships: [];
      };
      public_items: {
        Row: {
          availability: string | null;
          brand: string | null;
          buy_online_url: string | null;
          category: string | null;
          condition: string | null;
          currency: string | null;
          description: string | null;
          kind: string | null;
          name: string | null;
          photos: Json | null;
          sale_price: number | null;
          short_id: string | null;
          slug: string | null;
          updated_at: string | null;
        };
        Relationships: [];
      };
      purchase_order_progress: {
        Row: {
          expected_at: string | null;
          is_overdue: boolean | null;
          last_received_at: string | null;
          po_number: string | null;
          po_status: Database["public"]["Enums"]["purchase_order_status"] | null;
          product_id: string | null;
          purchase_order_id: string | null;
          purchase_order_line_id: string | null;
          quantity_cancelled: number | null;
          quantity_ordered: number | null;
          quantity_outstanding: number | null;
          quantity_received: number | null;
          supplier_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "low_stock";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "purchase_order_lines_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_stock";
            referencedColumns: ["product_id"];
          },
        ];
      };
      report_lines: {
        Row: {
          bicii_yield_after_cc: number | null;
          bike_id: string | null;
          category_id: string | null;
          channel: string | null;
          checked_in_at: string | null;
          collected_at: string | null;
          completed_at: string | null;
          consignment_item_id: string | null;
          cost_pending: boolean | null;
          cost_total: number | null;
          cult_commons_rate: number | null;
          cult_commons_share: number | null;
          currency: string | null;
          customer_id: string | null;
          description: string | null;
          document_id: string | null;
          document_number: string | null;
          entry_key: string | null;
          entry_kind: string | null;
          inventory_unit_id: string | null;
          is_loss: boolean | null;
          lead_mechanic_id: string | null;
          line_type: string | null;
          ownership_type: string | null;
          product_id: string | null;
          quantity: number | null;
          recognised: boolean | null;
          recognized_at: string | null;
          recognized_day: string | null;
          sale_total: number | null;
          service_id: string | null;
          source: string | null;
          source_line_id: string | null;
          unit_direct_cost: number | null;
          unit_sale_price: number | null;
          yield_total: number | null;
        };
        Relationships: [];
      };
      shopify_sync_status: {
        Row: {
          last_error: string | null;
          last_error_code: string | null;
          last_pushed_at: string | null;
          last_pushed_quantity: number | null;
          name: string | null;
          open_job_id: string | null;
          open_job_next_attempt_at: string | null;
          open_job_status: Database["public"]["Enums"]["integration_job_status"] | null;
          product_id: string | null;
          publication_status: Database["public"]["Enums"]["publication_status"] | null;
          publish_online: boolean | null;
          shopify_origin: string | null;
          shopify_product_id: string | null;
          shopify_variant_id: string | null;
          short_id: string | null;
          sync_status: Database["public"]["Enums"]["shopify_sync_status"] | null;
          tracking_type: Database["public"]["Enums"]["tracking_type"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "shopify_product_sync_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: true;
            referencedRelation: "low_stock";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "shopify_product_sync_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: true;
            referencedRelation: "product_stock";
            referencedColumns: ["product_id"];
          },
        ];
      };
      stock_levels: {
        Row: {
          last_movement_at: string | null;
          location_id: string | null;
          on_hand: number | null;
          product_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "inventory_movements_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "low_stock";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "inventory_movements_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_stock";
            referencedColumns: ["product_id"];
          },
        ];
      };
      stock_reconciliation: {
        Row: {
          issue: string | null;
          last_movement_at: string | null;
          ledger_on_hand: number | null;
          location_id: string | null;
          product_id: string | null;
          tracking_type: Database["public"]["Enums"]["tracking_type"] | null;
          units_in_stock: number | null;
        };
        Relationships: [];
      };
      unit_ledger_disposition: {
        Row: {
          disposition: string | null;
          disposition_movement_id: number | null;
          disposition_ref: string | null;
          last_movement_at: string | null;
          ledger_location_id: string | null;
          ledger_on_hand: number | null;
          location_nets: Json | null;
          location_out_of_range: boolean | null;
          unit_id: string | null;
        };
        Relationships: [];
      };
      unit_reconciliation: {
        Row: {
          disposition: string | null;
          disposition_ref: string | null;
          expected_on_hand: number | null;
          issue: string | null;
          issue_detail: string | null;
          last_movement_at: string | null;
          ledger_location_id: string | null;
          ledger_on_hand: number | null;
          location_id: string | null;
          product_id: string | null;
          status: Database["public"]["Enums"]["unit_status"] | null;
          unit_id: string | null;
          unit_short_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "inventory_units_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "low_stock";
            referencedColumns: ["product_id"];
          },
          {
            foreignKeyName: "inventory_units_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "product_stock";
            referencedColumns: ["product_id"];
          },
        ];
      };
      work_order_activity: {
        Row: {
          age_days: number | null;
          appointment_id: string | null;
          bike_id: string | null;
          cancelled_at: string | null;
          cancelled_day: string | null;
          checked_in_at: string | null;
          checked_in_day: string | null;
          collected_at: string | null;
          collected_day: string | null;
          completed_at: string | null;
          completed_day: string | null;
          currency: string | null;
          customer_id: string | null;
          days_awaiting_collection: number | null;
          days_to_complete: number | null;
          days_to_start: number | null;
          is_open: boolean | null;
          is_overdue: boolean | null;
          job_number: string | null;
          lead_mechanic_id: string | null;
          ready_day: string | null;
          ready_for_collection_at: string | null;
          started_at: string | null;
          started_day: string | null;
          status: Database["public"]["Enums"]["work_order_status"] | null;
          time_to_complete: string | null;
          work_order_id: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      appointment_event_type: [
        "booked",
        "confirmed",
        "arrived",
        "checked_in",
        "completed",
        "cancelled",
        "no_show",
        "details_changed",
        "work_order_linked",
      ],
      appointment_source: ["staff", "customer"],
      appointment_status: [
        "booked",
        "confirmed",
        "arrived",
        "checked_in",
        "completed",
        "cancelled",
        "no_show",
      ],
      assignment_role: ["lead", "additional"],
      attachment_entity: [
        "bike",
        "work_order",
        "product",
        "inventory_unit",
        "customer",
        "consignment_item",
      ],
      attachment_event_type: ["created", "visibility_changed", "caption_changed", "deleted"],
      attachment_visibility: ["internal", "customer", "public"],
      bike_ownership_event_type: ["registered", "transferred"],
      category_kind: ["service", "product"],
      charge_bearer: ["consignor", "shop"],
      closure_kind: ["closed", "custom_hours"],
      consignment_item_event_type: [
        "received",
        "terms_changed",
        "charge_added",
        "charge_voided",
        "status_changed",
        "stock_returned",
      ],
      consignment_status: ["active", "sold", "returned", "withdrawn"],
      customer_job_status: [
        "received",
        "awaiting_customer",
        "awaiting_parts",
        "in_progress",
        "completed",
        "ready_for_collection",
        "collected",
      ],
      integration_audit_type: [
        "publish_online_changed",
        "sync_requested",
        "variant_linked",
        "customer_linked",
        "job_retried",
        "job_dismissed",
        "settings_changed",
      ],
      integration_event_status: ["pending", "processed", "skipped", "failed", "rejected"],
      integration_job_kind: ["shopify_event", "product_sync"],
      integration_job_status: ["queued", "running", "done", "needs_attention", "dismissed"],
      integration_rejection_reason: [
        "hmac_invalid",
        "webhook_secret_missing",
        "shop_not_configured",
        "shop_domain_mismatch",
        "missing_headers",
        "body_not_json",
      ],
      inventory_unit_event_type: [
        "created",
        "status_changed",
        "moved",
        "details_changed",
        "price_changed",
        "cost_changed",
        "archived",
        "unarchived",
      ],
      label_kind: ["product", "unit", "bike"],
      line_type: ["service", "inventory", "manual"],
      location_kind: ["shop_floor", "workshop", "storage", "offsite"],
      movement_type: [
        "purchase_received",
        "job_consumption",
        "retail_sale",
        "online_sale",
        "stock_adjustment",
        "damaged",
        "return",
        "consignment_received",
        "consignment_returned",
        "transfer",
        "reversal",
      ],
      ownership_type: ["shop_owned", "consignment", "customer_owned"],
      part_request_kind: ["part", "service"],
      part_request_status: [
        "proposed",
        "quoted",
        "approved",
        "declined",
        "ordered",
        "fitted",
        "cancelled",
      ],
      payment_kind: ["deposit", "balance"],
      payment_status: ["pending", "paid", "failed", "expired", "partially_refunded", "refunded"],
      permission_key: [
        "view_costs",
        "manage_inventory",
        "adjust_stock",
        "manage_consignments",
        "manage_purchasing",
        "manage_staff",
        "view_financial_reports",
      ],
      print_status: ["queued", "rendered", "printed", "failed"],
      printer_adapter: ["browser", "pdf", "network_raw", "bluetooth"],
      product_event_type: [
        "created",
        "details_changed",
        "price_changed",
        "cost_changed",
        "publication_changed",
        "archived",
        "unarchived",
      ],
      publication_status: ["draft", "internal_only", "public", "sold", "archived"],
      purchase_order_event_type: [
        "created",
        "details_changed",
        "line_added",
        "line_changed",
        "line_removed",
        "submitted",
        "received",
        "status_changed",
        "cancelled",
      ],
      purchase_order_status: ["draft", "submitted", "partially_received", "received", "cancelled"],
      quote_channel: ["whatsapp", "email", "link"],
      quote_status: ["open", "answered", "withdrawn"],
      report_date_basis: ["sale", "check_in", "completion", "collection"],
      report_dimension: [
        "job",
        "product",
        "category",
        "service",
        "mechanic",
        "ownership",
        "channel",
      ],
      report_grain: ["day", "week", "month"],
      sale_source: ["retail", "online_shopify", "work_order"],
      sale_status: ["recorded", "partially_refunded", "refunded", "voided"],
      schedule_entity: ["shop_settings", "shop_hours", "closure_override", "appointment_type"],
      schedule_event_type: ["created", "updated", "deleted"],
      shopify_sync_status: ["not_synced", "pending", "synced", "error", "unpublished"],
      staff_event_type: [
        "created",
        "details_changed",
        "role_changed",
        "deactivated",
        "reactivated",
        "permission_granted",
        "permission_revoked",
      ],
      staff_role: ["admin", "manager", "mechanic"],
      stripe_event_source: ["webhook", "api_read"],
      stripe_event_status: ["received", "applied", "ignored", "needs_attention", "rejected"],
      stripe_refund_status: ["pending", "requires_action", "succeeded", "failed", "canceled"],
      stripe_rejection_reason: [
        "stripe_off",
        "signature_invalid",
        "signature_expired",
        "body_not_json",
        "event_shape_invalid",
        "livemode_mismatch",
        "not_recorded",
      ],
      tracking_type: ["quantity", "unique"],
      unit_status: [
        "available",
        "reserved",
        "sold",
        "returned_to_consignor",
        "written_off",
        "held_for_customer",
      ],
      work_order_event_type: [
        "checked_in",
        "status_changed",
        "completed",
        "ready_for_collection",
        "collected",
        "cancelled",
        "reopened",
        "assignment_changed",
        "note_added",
        "diagnosis_added",
        "details_changed",
        "approval_flagged",
        "photo_added",
        "photo_removed",
        "line_added",
        "line_voided",
        "stock_consumed",
        "stock_reversed",
        "appointment_linked",
        "part_requested",
        "part_request_cancelled",
        "quote_sent",
        "quote_withdrawn",
        "quote_answered",
        "part_ordered",
        "part_fitted",
        "payment_received",
        "payment_refunded",
        "payment_refund_failed",
      ],
      work_order_note_kind: ["note", "diagnosis"],
      work_order_status: [
        "received",
        "diagnosing",
        "awaiting_customer",
        "awaiting_parts",
        "ready_to_start",
        "in_progress",
        "paused",
        "completed",
        "ready_for_collection",
        "collected",
        "cancelled",
      ],
    },
  },
  reporting: {
    Enums: {},
  },
} as const;
