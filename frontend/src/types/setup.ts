export interface SetupStatus {
  setup_required: boolean;
  organization_count: number;
  user_count: number;
  dev_mode_enabled: boolean;
  message: string | null;
}

export interface CreateDevSetupRequest {
  organization_name?: string;
  user_email?: string;
  user_name?: string;
}

export interface CreateDevSetupResponse {
  organization_id: string;
  user_id: string;
  dev_user_id: string;
  organization_name: string;
  user_email: string;
  message: string;
}
