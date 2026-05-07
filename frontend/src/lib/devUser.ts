const DEV_USER_KEY = 'whereas.dev_user_id'
export const getDevUserId = () => localStorage.getItem(DEV_USER_KEY)?.trim() ?? ''
export const setDevUserId = (value: string) => localStorage.setItem(DEV_USER_KEY, value.trim())
