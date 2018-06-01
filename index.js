/*
create token: https://developer.github.com/v4/guides/forming-calls/#authenticating-with-graphql
*/
const link = (href, text=href) => `<a href="${href}">${text}</a>`;
const getAuthor = target => target.committedViaWeb ? target.author : target.committer;
const branchLevel = ({prs}) => {
	if (!prs || !prs.length) return 2;
	if (prs.some(pr => pr.state === 'OPEN')) return 3;
	return 1;
};

const form = document.forms[0];

/* levels:
- 0: no branch from you -> safely removable
- 1: at most a branch with a CLOSED/MERGED PR -> quite safe, but you may want to check the closed ones
- 2: a branch with no PR -> could be removed, but check this branch first
- 3: an OPEN PR -> don't remove, or check it if you want to close it (if old)
*/


if (localStorage.ghToken) {
	form.token.value = localStorage.ghToken;
}

form.onsubmit = async e => {
	e.preventDefault();
	const login = form.login.value;
  localStorage.ghToken = form.token.value;
	form.sb.disabled = true;

	try {
		const removables = []; // {id, name, parent, lvl (0: , 1 no branch from you, 2: branch without PR, 3: branch with a closed or merged PR)}
		let user;
		let cursor;
		for (let i=0; i<100; i++) {
			user = await getForks({login, after: cursor});
			const forks = user.repositories.nodes;
			console.log(forks.length);

			// inspect every fork, and see if it's safe to remove
			for (const fork of forks) {
				const refs = fork.refs.nodes;
				if (fork.refs.pageInfo.hasNextPage) {
					refs.push(...await getAllRefs({owner: login, name: fork.name, after: fork.refs.pageInfo.endCursor}));
				}
				// console.log(fork.name, refs.length);
				const myBranches = fork.refs.nodes
					.filter(ref => getAuthor(ref.target).email === user.email)
					.map(({name, target, associatedPullRequests: {nodes: prs}}) => ({name, target, prs}))
					.sort((a,b) => a.prs.length && b.prs.length ? a.prs[0].createdAt - b.prs[0].createdAt : a.prs.length ? -1 : 1);

				const lvl = Math.max(0, ...myBranches.map(branchLevel));

				const removable = {
					id: fork.id,
					name: fork.name,
					nameWithOwner: fork.nameWithOwner,
					parent: fork.parent.nameWithOwner,
					lvl,
					branches: myBranches
				};
				removables.push(removable);
			}
		
			cursor = user.repositories.pageInfo.endCursor;
			if (!user.repositories.pageInfo.hasNextPage) {
				break;
			}
		}
		
		renderResults(removables);

	} catch(err) {
		output.innerHTML = `<a href="https://developer.github.com/v4/guides/forming-calls/#authenticating-with-graphql">${err && err.message || 'Create a GH token!'}</a>`
  }
  form.sb.disabled = false;
};

const getAllRefs = async ({owner, name, after: intialAfter}) => {
	let after = intialAfter;
	const allRefs = [];
	for (let i=0;i<20;i++) {
		const {repository: {refs}} = await gql({
			query: `query getOtherRefs($owner: String!, $name: String!, $after: String) {
				repository(owner: $owner, name: $name) {
					refs(refPrefix: "refs/heads/", first: 50, after: $after) {
						${refsFragment}
					}
				}	
			}`,
			variables: {owner, name, after}
		});
		allRefs.push(...refs.nodes);
		after = refs.pageInfo.endCursor;
		if (!refs.pageInfo.hasNextPage) break;
	}
	return allRefs;
}

const refsFragment = 
`nodes {
	name
	target {
		... on Commit {
			author {email}
			committer{email}
			committedViaWeb
		}
		oid
	}
	associatedPullRequests(first: 20) {
		nodes {
			state
			url
			createdAt
		}
	}
}
pageInfo {
	endCursor
	hasNextPage
}`;

const getForks = ({login, after, first = 100}) => gql({
	query: `query getForks($login: String!, $first: Int, $after: String) {
	user(login: $login) {
		email
		repositories(first: $first, after: $after, isFork: true) {
			nodes {
				id
				name
				nameWithOwner
				parent {nameWithOwner}
				refs(refPrefix: "refs/heads/", first: 50) {
					${refsFragment}
				}
			}
			pageInfo {
				endCursor
				hasNextPage
			}
		}
	}
}`,
	variables: {
		login, first, after
	}
})
	.then(d => d.user);

/* // could also query this for the forks, and check if a a branch 'in doubt' got merged in master (example if you got write perm)
		parent {
			defaultBranchRef {
				name
				target {
					... on Commit { 
						history(first: 10) {
							nodes{
								oid
							}
							pageInfo {endCursor}
						}
					}
					commitUrl
				}
			}
		}

*/

const renderResults = removables => {
	const rems = removables.reduce((m, {lvl, ...rest}) => m.set(lvl, [...m.get(lvl), rest]), new Map([[0,[]],[1,[]],[2,[]],[3,[]]]));
	const login = form.login.value;

	output.innerHTML = `
<details open>
<summary>0: no branch from you -> safely removable <span class="count">${rems.get(0).length}</span></summary>
<ul>
	${rems.get(0).map(({id, nameWithOwner}) => `<li data-id="${id}" data-name="${nameWithOwner}">${link(`https://github.com/${nameWithOwner}`)}<a title="remove ${nameWithOwner}"></a></li>`).join('')}
</ul>
</details>

<details open>
<summary>1: at most a branch with a CLOSED/MERGED PR -> quite safe, but you may want to check the closed ones <span class="count">${rems.get(1).length}</span></summary>
<ul>
	${rems.get(1).map(({id, nameWithOwner, parent}) => `<li data-id="${id}" data-name="${nameWithOwner}">${link(`https://github.com/${parent}/pulls/${login}?q=is:closed`)}<a title="remove ${nameWithOwner}"></a></li>`).join('')}
</ul>
</details>

<details open>
<summary>2: a branch with no PR -> could be removed, but check those branches first <span class="count">${rems.get(2).length}</span></summary>
<ul>
	${rems.get(2).map(({id, nameWithOwner, branches}) => `<li data-id="${id}" data-name="${nameWithOwner}">${link(`https://github.com/${nameWithOwner}`)}<a title="remove ${nameWithOwner}"></a><nav>${branches.map(br => link(`https://github.com/${nameWithOwner}/tree/${br.name}`, br.name)).join('')}</nav></li>`).join('')}
</ul>
</details>


<details open>
<summary>3: an OPEN PR -> don't remove, or check it if you want to close it (if old) <span class="count">${rems.get(3).length}</span></summary>
<ul>
	${rems.get(3).map(({id, nameWithOwner, parent, branches}) => `<li data-id="${id}" data-name="${nameWithOwner}" title="Most recent PR: ${branches[0]&&branches[0].prs[0]&&branches[0].prs[0].createdAt.slice(0,10)}">${link(`https://github.com/${parent}/pulls/${login}`)}<a title="remove ${nameWithOwner}"></a></li>`).join('')}
</ul>
</details>`;

	output.onclick = e => {
		const el = e.target;
		if (el.tagName !== 'A' || el.href) return;
		const li = el.closest('li');
		if (!li) return;
		if (!window.confirm(`delete ${li.dataset.name} fork?`)) return;

		fetch(`https://api.github.com/repos/${li.dataset.name}?access_token=${localStorage.ghToken}`, {method: 'DELETE'}).then(r => r.json())
			.finally(() => {
				const r = removables.filter(rep => rep.nameWithOwner !== li.dataset.name);
				renderResults(r); // render again
			});
	};
}


const gql = ({query, variables}) => fetch('https://api.github.com/graphql', {
	method: 'POST',
	headers: {
		Authorization: `bearer ${localStorage.ghToken}`
	},
	body: JSON.stringify({
		query,
		variables
	})
})
	.then(async r => {
		if (!r.ok) {
			const d = await r.json();
			throw new Error(d.message || JSON.stringify(d));
		}
		if (r.status === 204) return;
		return r.json().then(d => {
			if (d.errors) {
				throw new Error(d.errors[0] && d.errors[0].message || `Failed on query ${JSON.stringify(query)}`)
			}
			return d.data;
		});
  });
