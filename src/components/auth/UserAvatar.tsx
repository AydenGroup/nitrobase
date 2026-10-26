import { Avatar, type AvatarProps } from "@mantine/core";

/**
 * A user's avatar: their chosen image (generated on this origin or an
 * https URL), or their initials when none is set. Initials are drawn by
 * Mantine in the browser, so nothing is fetched for them.
 */
export const UserAvatar: React.FC<
	AvatarProps & {
		user: { firstName: string; lastName: string; avatarUrl: string | null };
	}
> = ({ user, ...props }) => {
	const name = `${user.firstName} ${user.lastName}`.trim();
	return (
		<Avatar
			src={user.avatarUrl || undefined}
			name={name}
			color="initials"
			alt={name}
			{...props}
		/>
	);
};
