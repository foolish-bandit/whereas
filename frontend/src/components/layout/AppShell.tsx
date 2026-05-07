import { Link, NavLink } from 'react-router-dom'

export function AppShell({ children, devUserId }: { children: React.ReactNode; devUserId: string }) {
  return <div className='min-h-screen bg-slate-50 text-slate-900'>
    <div className='grid grid-cols-[220px_1fr]'>
      <aside className='min-h-screen border-r bg-white p-4'>
        <div className='mb-6 text-lg font-semibold'>Whereas</div>
        <nav className='space-y-1 text-sm'>
          <NavLink to='/contracts' className='block rounded px-3 py-2 hover:bg-slate-100'>Contracts</NavLink>
          <NavLink to='/upload' className='block rounded px-3 py-2 hover:bg-slate-100'>Upload</NavLink>
          <NavLink to='/settings' className='block rounded px-3 py-2 hover:bg-slate-100'>Settings / Dev Auth</NavLink>
        </nav>
      </aside>
      <main>
        <header className='flex items-center justify-between border-b bg-white px-6 py-3'>
          <div><h1 className='text-lg font-semibold'>Whereas</h1><p className='text-xs text-slate-500'>Self-hosted workspace</p></div>
          <div className='text-xs text-slate-600'>Dev User: {devUserId ? devUserId : <Link to='/settings' className='text-rose-600 underline'>Not configured</Link>}</div>
        </header>
        <div className='p-6'>{children}</div>
      </main>
    </div>
  </div>
}
